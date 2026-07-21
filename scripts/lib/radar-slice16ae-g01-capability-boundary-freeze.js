'use strict';

/**
 * radar-slice16ae-g01-capability-boundary-freeze — RADAR Slice 16AE locks.
 *
 * Audit-only freeze of the central capability boundary required before any
 * G01-A dry-run. Inventories WhatsApp send + Staff/DB/Stripe mutation + read
 * adapters under a single identity rule. Defines fail-closed decideCapability
 * (inventory lookup + exact tenant/location bind + pinned effect/class; immutable
 * per-turn tenant/location/adapter boundary). Does NOT implement runtime
 * behavior, deploy, or live evidence.
 *
 * Completeness: independently enumerate capability IDs from actual Hermes
 * registrations and provider-acquisition/call sites, then compare bidirectionally
 * to a separate frozen specification fixture. Implementation expected-set
 * constants are not the authority — verifiers must load the frozen fixture.
 */

const fs = require('fs');
const path = require('path');

const MASTER_BASIS = '0a2fb08486b835dd45a4fc904e3dd152702bea6f';
const SLICE = 'RADAR-16AE';
const OUTCOME_ID = '16AE_g01_capability_boundary_freeze';
const GATE_ID = 'G01_correlation_structured_logs';
const PROGRESS_CLASS = 'audit_only_capability_boundary_freeze';
const BRANCH = 'radar/slice-16ae-g01-capability-boundary-freeze';

const INVENTORY_REL = 'fixtures/radar-operations/slice16ae-adapter-inventory.json';
const DESIGN_REL = 'fixtures/radar-operations/slice16ae-capability-boundary-freeze.json';
const CONTRACT_REL = 'fixtures/radar-operations/slice16ae-expected-contract.json';
const FROZEN_SPEC_REL = 'fixtures/radar-operations/slice16ae-frozen-capability-ids.json';

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';

/** Single fail-closed decision point (design freeze — not wired at runtime). */
const DECISION_POINT = 'decideCapability';

/** Later runtime owner (not created in 16AE). */
const LATER_OWNER_MODULE = 'docker/hermes-staging/wolfhouse/capability_boundary.py';
const LATER_OWNER_SYMBOL = 'decide_capability';
const LATER_OWNER_TESTS = 'docker/hermes-staging/wolfhouse/test_capability_boundary.py';
const LATER_STAFF_OWNER_MODULE = 'scripts/lib/g01-capability-boundary.js';
const LATER_STAFF_OWNER_SYMBOL = 'decideCapability';
const LATER_STAFF_OWNER_TESTS = 'scripts/verify-g01-capability-boundary.js';

const NEXT_SLICE_ID = '16AF_candidate_capability_boundary_runtime_apply';

const EFFECT_WHATSAPP_SEND = 'whatsapp_send';
const EFFECT_MUTATION = 'mutation';
const EFFECT_READ = 'read_dispatch';
const EFFECT_UNKNOWN = 'unknown';

const TENANT_WOLFHOUSE = 'wolfhouse-somo';
const TENANT_SUNSET = 'sunset';
const ALLOWED_TENANTS = Object.freeze([TENANT_WOLFHOUSE, TENANT_SUNSET]);

const LOCATION_WOLFHOUSE = 'wolfhouse';
const LOCATION_SUNSET = 'sunset';
const ALLOWED_LOCATIONS = Object.freeze([LOCATION_WOLFHOUSE, LOCATION_SUNSET]);
/** Canonical tenant ↔ location pairing (immutable context). */
const TENANT_LOCATION = Object.freeze({
  [TENANT_WOLFHOUSE]: LOCATION_WOLFHOUSE,
  [TENANT_SUNSET]: LOCATION_SUNSET,
});

/**
 * Identity rule (frozen): one adapter_id per registered active Hermes tool
 * primary staff route, or per unique external acquisition site reached on an
 * active Hermes guest turn before Meta Graph / Staff HTTP / DB pool / Stripe /
 * in-process queue / session-store acquisition. Producer/path symbols that
 * converge to the same acquisition site collapse to one entry. Completeness is
 * source-derived exact-set equality vs a separate frozen specification —
 * never a self-reported complete flag or circular expected-set constant.
 */
const IDENTITY_RULE = Object.freeze({
  id: 'ADAPTER_IDENTITY_REGISTERED_TOOL_ROUTE_OR_UNIQUE_EXTERNAL_ACQUISITION',
  completeness_method: 'source_derived_exact_set_comparison',
  exact:
    'One adapter_id per (1) registered active Hermes tool primary /staff/bot/* '
    + 'route under the tenant that registers it, or (2) unique external '
    + 'acquisition site (meta_graph_http_client|staff_http_client|db_pool_client|'
    + 'stripe_sdk|in_process_queue|hermes_session_store) on an active Hermes '
    + 'guest turn. Collapse producer/path duplicates that converge before '
    + 'acquisition. Completeness = bidirectional exact-set equality between '
    + 'independently enumerated source IDs and a separate frozen specification.',
});

const PLUGIN_REL = 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py';
const PAUSE_GATE_REL = 'docker/hermes-staging/wolfhouse/pause_gate.py';

/**
 * Classifiers map source-discovered Hermes tool registrations → capability IDs.
 * Not the frozen expected set; a newly registered tool without an entry is RED.
 */
const HERMES_TOOL_CLASSIFIERS = Object.freeze({
  check_availability: { adapter_id: 'hermes_post_bot_availability_check', effect: EFFECT_READ },
  quote_booking: { adapter_id: 'hermes_post_bot_booking_preview', effect: EFFECT_READ },
  preview_package_prices: { adapter_id: 'hermes_post_bot_package_price_preview', effect: EFFECT_READ },
  get_payment_status: { adapter_id: 'hermes_post_bot_payments_status', effect: EFFECT_READ },
  get_guest_payment_status: { adapter_id: 'hermes_post_bot_guest_payment_status', effect: EFFECT_READ },
  get_surf_report: { adapter_id: 'hermes_post_bot_surf_report', effect: EFFECT_READ },
  list_my_bookings: { adapter_id: 'hermes_post_bot_bookings_by_phone', effect: EFFECT_READ },
  get_house_info: { adapter_id: 'hermes_post_bot_house_info', effect: EFFECT_READ },
  lookup_catalog_service: { adapter_id: 'hermes_post_bot_catalog_lookup', effect: EFFECT_READ },
  owner_insights: { adapter_id: 'hermes_post_bot_owner_insights', effect: EFFECT_READ },
  get_sunset_rental_price: { adapter_id: 'hermes_post_bot_sunset_rental_price', effect: EFFECT_READ },
  get_sunset_full_day_equipment_addon: {
    adapter_id: 'hermes_post_bot_sunset_full_day_addon',
    effect: EFFECT_READ,
  },
  get_sunset_private_lesson: {
    adapter_id: 'hermes_post_bot_sunset_private_lesson',
    effect: EFFECT_READ,
  },
  get_sunset_lesson_availability: {
    adapter_id: 'hermes_post_bot_sunset_lesson_availability',
    effect: EFFECT_READ,
  },
  get_sunset_joinable_courses: {
    adapter_id: 'hermes_post_bot_sunset_joinable_courses',
    effect: EFFECT_READ,
  },
  get_sunset_lesson_catalog: { adapter_id: 'hermes_post_bot_sunset_catalog', effect: EFFECT_READ },
  get_sunset_offering_quote: {
    adapter_id: 'hermes_post_bot_sunset_offering_quote',
    effect: EFFECT_READ,
  },
  create_booking_from_plan: {
    adapter_id: 'hermes_post_bot_booking_create_from_plan',
    effect: EFFECT_MUTATION,
  },
  create_payment_link: { adapter_id: 'hermes_post_bot_create_stripe_link', effect: EFFECT_MUTATION },
  create_guest_payment_link: {
    adapter_id: 'hermes_post_bot_create_guest_payment_link',
    effect: EFFECT_MUTATION,
  },
  create_balance_payment_link: {
    adapter_id: 'hermes_post_bot_create_balance_link',
    effect: EFFECT_MUTATION,
  },
  add_service_to_booking: {
    adapter_id: 'hermes_post_bot_addon_requests_create',
    effect: EFFECT_MUTATION,
  },
  add_catalog_service_to_booking: {
    adapter_id: 'hermes_post_bot_add_catalog_service',
    effect: EFFECT_MUTATION,
  },
  save_transfer_request: { adapter_id: 'hermes_post_bot_transfers_save', effect: EFFECT_MUTATION },
  update_guest_packages: {
    adapter_id: 'hermes_post_bot_guest_packages_update',
    effect: EFFECT_MUTATION,
  },
  update_booking_contact: { adapter_id: 'hermes_post_bot_update_contact', effect: EFFECT_MUTATION },
  flag_needs_human: { adapter_id: 'hermes_post_bot_needs_human', effect: EFFECT_MUTATION },
  create_sunset_booking: {
    adapter_id: 'hermes_post_bot_sunset_booking_create',
    effect: EFFECT_MUTATION,
  },
  create_sunset_payment_link: {
    adapter_id: 'hermes_post_bot_sunset_payment_link',
    effect: EFFECT_MUTATION,
  },
  // Registered as tools but write-on-read at Staff — DENY class.
  get_sunset_payment_status: {
    adapter_id: 'sunset_payment_status_reconcile_write',
    effect: EFFECT_MUTATION,
  },
  get_sunset_waiver_link: { adapter_id: 'sunset_waiver_ensure_write', effect: EFFECT_MUTATION },
});

/**
 * Unique external acquisition / call sites not covered solely by Hermes tool
 * registration tuples. Each pin must be present in source; omission is RED.
 */
const ACQUISITION_SITE_CLASSIFIERS = Object.freeze([
  {
    adapter_id: 'hermes_whatsapp_cloud_graph_send',
    effect: EFFECT_WHATSAPP_SEND,
    rel: 'docker/hermes-staging/apply_gateway_patches.py',
    needle: 'async def _patched_whatsapp_cloud_send',
  },
  {
    adapter_id: 'hermes_burst_coalesce_queue_send',
    effect: EFFECT_WHATSAPP_SEND,
    rel: 'docker/hermes-staging/wolfhouse/whatsapp_burst_coalesce.py',
    needle: 'class BurstCoalescer',
  },
  {
    adapter_id: 'hermes_busy_text_queue_send',
    effect: EFFECT_WHATSAPP_SEND,
    rel: 'docker/hermes-staging/apply_gateway_patches.py',
    needle: 'async def _patched_whatsapp_cloud_send',
    note: 'busy_text queue acquires in-process queue before patched Graph send',
  },
  {
    adapter_id: 'staff_luna_whatsapp_provider_send',
    effect: EFFECT_WHATSAPP_SEND,
    rel: 'scripts/lib/luna-whatsapp-provider.js',
    needle: 'async function sendLunaWhatsAppMessage',
  },
  {
    adapter_id: 'hermes_whatsapp_thread_mirror_enqueue',
    effect: EFFECT_MUTATION,
    rel: 'docker/hermes-staging/wolfhouse_whatsapp_mirror.py',
    needle: 'def mirror_whatsapp_thread',
  },
  {
    adapter_id: 'hermes_whatsapp_thread_mirror_deliver',
    effect: EFFECT_MUTATION,
    rel: 'docker/hermes-staging/wolfhouse_whatsapp_mirror.py',
    needle: 'def _deliver(self, item: dict)',
  },
  {
    adapter_id: 'staff_whatsapp_thread_mirror_db_write',
    effect: EFFECT_MUTATION,
    rel: 'scripts/lib/luna-hermes-whatsapp-thread-mirror.js',
    needle: 'async function mirrorHermesWhatsAppThreadMessage',
  },
  {
    adapter_id: 'hermes_guest_fresh_start_reset',
    effect: EFFECT_MUTATION,
    rel: 'docker/hermes-staging/wolfhouse_guest_fresh_start.py',
    needle: 'def register_fresh_start_route',
  },
  {
    adapter_id: 'hermes_local_automation_block_session',
    effect: EFFECT_MUTATION,
    rel: 'docker/hermes-staging/wolfhouse/explicit_human_handoff.py',
    needle: 'def mark_local_automation_blocked',
  },
  {
    adapter_id: 'staff_bot_stripe_checkout_sessions_create',
    effect: EFFECT_MUTATION,
    rel: 'scripts/lib/staff-bot-v2-routes.js',
    needle: 'stripe.checkout.sessions.create',
  },
  {
    adapter_id: 'staff_db_handoff_persist',
    effect: EFFECT_MUTATION,
    rel: 'scripts/lib/luna-guest-handoff-persist.js',
    needle: 'async function markConversationNeedsHumanByPhone',
  },
  {
    adapter_id: 'sunset_payment_status_reconcile_write',
    effect: EFFECT_MUTATION,
    rel: 'scripts/lib/stripe-payment-reconcile.js',
    needle: 'async function reconcilePendingStripePaymentsForBooking',
    dual_classified_with_tool: 'get_sunset_payment_status',
  },
  {
    adapter_id: 'sunset_waiver_ensure_write',
    effect: EFFECT_MUTATION,
    rel: 'scripts/lib/sunset-waiver-booking.js',
    needle: 'async function ensureWaiverForBookingSoft',
    dual_classified_with_tool: 'get_sunset_waiver_link',
  },
  {
    adapter_id: 'hermes_pause_gate_automation_check',
    effect: EFFECT_READ,
    rel: PAUSE_GATE_REL,
    needle: 'check-guest-automation-gate',
  },
]);

/** Demonstrated prior omissions / extras the adversarial suite must catch. */
const DEMONSTRATED_OMISSION_IDS = Object.freeze([
  'hermes_post_bot_sunset_full_day_addon',
  'hermes_post_bot_sunset_private_lesson',
  'hermes_post_bot_sunset_joinable_courses',
]);
const DEMONSTRATED_EXTRA_IDS = Object.freeze([
  'staff_bot_booking_dry_run',
]);

const REQUIRED_SEND_CATEGORIES = Object.freeze(['direct', 'queued']);
const REQUIRED_MUTATION_CATEGORIES = Object.freeze([
  'direct',
  'queued',
  'mirror',
  'handoff',
  'booking_payment',
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
  'self_reported_inventory_complete_flag',
  'context_tamper_accepted',
  'dry_run_activatable',
  'circular_expected_set_derivation',
  'missing_turn_accepted',
  'cross_decision_context_drift_accepted',
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
  FROZEN_SPEC_REL,
  'scripts/lib/radar-slice16ae-g01-capability-boundary-freeze.js',
  'scripts/verify-radar-slice16ae-g01-capability-boundary-freeze.js',
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

/** Collapsed producer/path duplicates (must not appear as separate adapters). */
const COLLAPSED_DUPLICATE_IDS = Object.freeze([
  'hermes_whatsapp_cloud_text_send',
  'hermes_whatsapp_cloud_media_send',
  'hermes_interactive_clarify_send',
  'hermes_interactive_exec_approval_send',
  'hermes_explicit_handoff_ack_send',
  'agent_payment_link_guest_text_send',
  'hermes_output_guard_fallback_send',
  'hermes_outage_fallback_send',
  'hermes_simulate_outbound_capturing_send',
  'staff_notify_human_needed_whatsapp',
  'staff_notify_new_conversation_whatsapp',
  'staff_bot_guest_reply_send_provider',
  'staff_bot_booking_confirmation_send',
  'hermes_whatsapp_typing_indicator_send',
  'hermes_plugin_register_future_send_surface',
  'hermes_plugin_register_future_mutation_surface',
  'hermes_explicit_handoff_persist',
  'staff_bot_booking_dry_run',
]);

function failClosed(code, errors) {
  return Object.freeze({
    ok: false,
    fail_closed: true,
    decision: 'deny',
    code,
    errors: Object.freeze(errors || [code]),
  });
}

function rootJoin(...parts) {
  return path.join(__dirname, '..', '..', ...parts);
}

function sortedCopy(ids) {
  return [...ids].sort();
}

function setsEqual(a, b) {
  const aa = sortedCopy(a);
  const bb = sortedCopy(b);
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i += 1) {
    if (aa[i] !== bb[i]) return false;
  }
  return true;
}

function setDiff(a, b) {
  const bb = new Set(b);
  return [...a].filter((x) => !bb.has(x)).sort();
}

/**
 * Load the separate frozen capability-ID specification (authority for expected set).
 * Verifiers must use this — not hardcoded implementation expected-set constants.
 */
function loadFrozenCapabilityIds(rootDir) {
  const root = rootDir || rootJoin();
  const abs = path.join(root, FROZEN_SPEC_REL);
  if (!fs.existsSync(abs)) {
    return failClosed('frozen_specification_missing', [
      `missing frozen specification: ${FROZEN_SPEC_REL}`,
    ]);
  }
  const spec = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const whatsapp_send = [...(spec.whatsapp_send_ids || [])];
  const mutation = [...(spec.mutation_ids || [])];
  const read_dispatch = [...(spec.read_dispatch_ids || [])];
  const counts = {
    whatsapp_send: whatsapp_send.length,
    mutation: mutation.length,
    read_dispatch: read_dispatch.length,
    total: whatsapp_send.length + mutation.length + read_dispatch.length,
  };
  if (
    spec.counts
    && (spec.counts.whatsapp_send !== counts.whatsapp_send
      || spec.counts.mutation !== counts.mutation
      || spec.counts.read_dispatch !== counts.read_dispatch
      || spec.counts.total !== counts.total)
  ) {
    return failClosed('frozen_specification_count_mismatch', [
      'frozen specification counts must match id list lengths',
    ]);
  }
  return Object.freeze({
    ok: true,
    path: FROZEN_SPEC_REL,
    identity_rule_id: spec.identity_rule_id,
    completeness_method: spec.completeness_method,
    whatsapp_send: Object.freeze(whatsapp_send),
    mutation: Object.freeze(mutation),
    read_dispatch: Object.freeze(read_dispatch),
    counts: Object.freeze(counts),
  });
}

function indexInventoryById(inventory) {
  const map = new Map();
  const inv = inventory || {};
  for (const a of [
    ...(inv.whatsapp_send_adapters || []),
    ...(inv.mutation_adapters || []),
    ...(inv.read_dispatch_adapters || []),
  ]) {
    if (a && a.adapter_id) map.set(a.adapter_id, a);
  }
  return map;
}

/**
 * Bind one immutable per-turn boundary object for tenant+location+adapter
 * decisions. Rejects missing/mismatched repeated context across decisions.
 */
function bindTurnBoundary(decisionContext, priorBoundary) {
  const turnId = decisionContext && decisionContext.turn_id;
  const tenant = decisionContext && decisionContext.tenant;
  const location = decisionContext && decisionContext.location;
  const adapterId = decisionContext && decisionContext.adapter_id;

  if (turnId == null || String(turnId).trim() === '') {
    return failClosed('missing_turn_denied', [
      'canonical turn_id required and must be non-empty',
    ]);
  }
  if (tenant == null || tenant === '' || location == null || location === '' || !adapterId) {
    return failClosed('missing_turn_context', [
      'per-turn boundary requires tenant+location+adapter',
    ]);
  }

  const canonicalTurn = String(turnId);
  const decisionEntry = Object.freeze({
    adapter_id: adapterId,
    tenant,
    location,
  });

  if (!priorBoundary) {
    return Object.freeze({
      ok: true,
      turn_id: canonicalTurn,
      tenant,
      location,
      adapter_id: adapterId,
      decisions: Object.freeze([decisionEntry]),
    });
  }

  if (
    priorBoundary.turn_id == null
    || String(priorBoundary.turn_id).trim() === ''
    || priorBoundary.tenant == null
    || priorBoundary.tenant === ''
    || priorBoundary.location == null
    || priorBoundary.location === ''
  ) {
    return failClosed('missing_turn_context', [
      'prior per-turn boundary missing required turn/tenant/location context',
    ]);
  }

  if (String(priorBoundary.turn_id) !== canonicalTurn) {
    return failClosed('cross_decision_turn_drift', [
      `turn_id drift: prior=${priorBoundary.turn_id} current=${canonicalTurn}`,
    ]);
  }
  if (priorBoundary.tenant !== tenant || priorBoundary.location !== location) {
    return failClosed('cross_decision_context_drift', [
      `tenant/location drift on turn ${canonicalTurn}: `
        + `prior=${priorBoundary.tenant}/${priorBoundary.location} `
        + `current=${tenant}/${location}`,
    ]);
  }

  const priorDecisions = Array.isArray(priorBoundary.decisions)
    ? priorBoundary.decisions
    : [];
  return Object.freeze({
    ok: true,
    turn_id: canonicalTurn,
    tenant,
    location,
    adapter_id: adapterId,
    decisions: Object.freeze([...priorDecisions, decisionEntry]),
  });
}

/**
 * Audit-only classifier for the central capability decision.
 * Requires non-empty canonical turn_id, inventory lookup by adapter_id, exact
 * tenant+location binding, pinned effect/class, and one immutable per-turn
 * boundary object. Optional priorBoundary rejects missing/mismatched repeated
 * context. Denies all sends/mutations while permitting reads.
 */
function decideCapability(candidate, inventory, priorBoundary) {
  const c = candidate || {};

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
  if (c.claims_runtime_wired === true || c.claims_live_enforcement === true) {
    return failClosed('runtime_overclaim', [
      '16AE is audit-only; runtime enforcement is not claimed',
    ]);
  }
  if (c.claims_trace_implemented === true || c.claims_deploy === true || c.claims_live_evidence === true) {
    return failClosed('trace_deploy_live_overclaim', [
      '16AE forbids trace/deploy/live evidence claims',
    ]);
  }

  const turnIdRaw = c.turn_id;
  if (turnIdRaw == null || String(turnIdRaw).trim() === '') {
    return failClosed('missing_turn_denied', [
      'canonical turn_id required and must be non-empty',
    ]);
  }
  const turnId = String(turnIdRaw);

  const adapterId = String(c.adapter_id || '');
  if (!adapterId) {
    return failClosed('unknown_adapter_denied', [
      'missing adapter_id denies fail-closed',
    ]);
  }

  const byId = indexInventoryById(inventory);
  const pinned = byId.get(adapterId);
  if (!pinned) {
    return failClosed('unknown_adapter_denied', [
      `adapter_id not in inventory: ${adapterId}`,
    ]);
  }

  const tenant = c.tenant;
  if (tenant == null || tenant === '') {
    return failClosed('missing_tenant_denied', [
      'tenant binding required; missing tenant denies',
    ]);
  }
  if (!ALLOWED_TENANTS.includes(tenant)) {
    return failClosed('unknown_tenant_denied', [
      `tenant must be exact wolfhouse-somo or sunset; got ${tenant}`,
    ]);
  }
  const allowed = Array.isArray(pinned.allowed_tenants) ? pinned.allowed_tenants : [];
  if (!allowed.includes(tenant)) {
    return failClosed('cross_tenant_denied', [
      `adapter ${adapterId} not bound to tenant ${tenant}`,
    ]);
  }
  if (c.tenant_confusion === true || c.cross_tenant === true) {
    return failClosed('tenant_confusion_forbidden', [
      'tenant must be explicit wolfhouse-somo or sunset; never confuse tenants',
    ]);
  }

  const location = c.location;
  if (location == null || location === '') {
    return failClosed('missing_location_denied', [
      'location binding required; missing location denies',
    ]);
  }
  if (!ALLOWED_LOCATIONS.includes(location)) {
    return failClosed('unknown_location_denied', [
      `location must be exact wolfhouse or sunset; got ${location}`,
    ]);
  }
  const allowedLocs = Array.isArray(pinned.allowed_locations) ? pinned.allowed_locations : [];
  if (!allowedLocs.includes(location)) {
    return failClosed('cross_location_denied', [
      `adapter ${adapterId} not bound to location ${location}`,
    ]);
  }
  if (TENANT_LOCATION[tenant] !== location) {
    return failClosed('tenant_location_mismatch', [
      `tenant ${tenant} must pair with location ${TENANT_LOCATION[tenant]}; got ${location}`,
    ]);
  }
  if (c.location_confusion === true || c.cross_location === true || c.context_tamper === true) {
    return failClosed('context_tamper_forbidden', [
      'immutable tenant/location/adapter context must not be confused or tampered',
    ]);
  }

  const boundary = bindTurnBoundary(
    { turn_id: turnId, tenant, location, adapter_id: adapterId },
    priorBoundary,
  );
  if (!boundary.ok) return boundary;

  // Effect/class from pinned inventory entry — never from caller input.
  const effect = String(pinned.effect || '');
  const capabilityClass = String(pinned.category || pinned.capability_class || '');

  if (!effect || effect === EFFECT_UNKNOWN) {
    return failClosed('unknown_adapter_denied', [
      'pinned entry missing effect class',
    ]);
  }

  let decision;
  let code;
  if (effect === EFFECT_READ) {
    decision = 'permit';
    code = 'permit_read_dispatch';
  } else if (effect === EFFECT_WHATSAPP_SEND || effect === EFFECT_MUTATION) {
    decision = 'deny';
    code = effect === EFFECT_WHATSAPP_SEND ? 'deny_whatsapp_send' : 'deny_mutation';
  } else {
    return failClosed('unknown_adapter_denied', [
      `unclassified pinned effect=${effect}`,
    ]);
  }

  return Object.freeze({
    ok: true,
    fail_closed: true,
    decision,
    code,
    adapter_id: adapterId,
    tenant,
    location,
    turn_id: turnId,
    effect,
    capability_class: capabilityClass,
    inventory_effect: effect,
    caller_effect_ignored: c.effect != null ? String(c.effect) : null,
    boundary,
    context: Object.freeze({
      tenant,
      location,
      adapter_id: adapterId,
      turn_id: turnId,
    }),
    note: 'Shape only — runtime not wired in 16AE',
  });
}

/**
 * Discover registered Hermes tool names from the plugin source (Wolfhouse +
 * Sunset tool tuples). Matches only registration tuples of the form
 * ("tool_name", "description...", tool_name, ...) — not schema/property strings.
 * Independent of frozen expected-set constants.
 */
function discoverRegisteredHermesToolNames(pluginSource) {
  const names = new Set();
  const re = /\(\s*"([a-z][a-z0-9_]*)"\s*,\s*"(?:[^"\\]|\\.)*"\s*,\s*\1\s*,/g;
  let m;
  while ((m = re.exec(pluginSource)) !== null) {
    names.add(m[1]);
  }
  return [...names].sort();
}

/**
 * Independently enumerate capability IDs from actual registrations and
 * provider-acquisition/call sites. Does NOT return frozen/expected constants.
 *
 * options.inject_discovered_tools — adversarial extra registrations (unclassified RED)
 * options.force_omit_acquisition_ids — adversarial acquisition omissions
 */
function enumerateCapabilityIdsFromSource(rootDir, options) {
  const opts = options || {};
  const root = rootDir || rootJoin();
  const pluginPath = path.join(root, PLUGIN_REL);
  const errors = [];

  if (!fs.existsSync(pluginPath)) {
    return failClosed('source_enumeration_failed', [`missing_plugin:${PLUGIN_REL}`]);
  }
  const plugin = fs.readFileSync(pluginPath, 'utf8');

  const discoveredTools = discoverRegisteredHermesToolNames(plugin);
  for (const extra of opts.inject_discovered_tools || []) {
    discoveredTools.push(extra);
  }

  const whatsapp_send = new Set();
  const mutation = new Set();
  const read_dispatch = new Set();

  function addId(effect, adapterId) {
    if (effect === EFFECT_WHATSAPP_SEND) whatsapp_send.add(adapterId);
    else if (effect === EFFECT_MUTATION) mutation.add(adapterId);
    else if (effect === EFFECT_READ) read_dispatch.add(adapterId);
    else errors.push(`unclassified_effect:${adapterId}:${effect}`);
  }

  for (const tool of discoveredTools) {
    const classifier = HERMES_TOOL_CLASSIFIERS[tool];
    if (!classifier) {
      errors.push(`newly_registered_unclassified_capability:${tool}`);
      continue;
    }
    addId(classifier.effect, classifier.adapter_id);
  }

  const omitAcq = new Set(opts.force_omit_acquisition_ids || []);
  for (const site of ACQUISITION_SITE_CLASSIFIERS) {
    if (omitAcq.has(site.adapter_id)) {
      errors.push(`acquisition_site_omission:${site.adapter_id}`);
      continue;
    }
    const abs = path.join(root, site.rel);
    if (!fs.existsSync(abs)) {
      errors.push(`acquisition_site_omission:${site.adapter_id}:missing_file:${site.rel}`);
      continue;
    }
    const text = fs.readFileSync(abs, 'utf8');
    if (!text.includes(site.needle)) {
      errors.push(`acquisition_site_omission:${site.adapter_id}:needle_absent`);
      continue;
    }
    addId(site.effect, site.adapter_id);
  }

  // booking-dry-run must NOT be treated as reachable Hermes read
  if (plugin.includes('booking-dry-run')) {
    errors.push('unexpected_hermes_booking_dry_run');
  }

  if (errors.length) {
    return failClosed(errors[0].split(':')[0], errors);
  }

  return Object.freeze({
    ok: true,
    code: 'source_enumeration_accepted',
    whatsapp_send: Object.freeze(sortedCopy(whatsapp_send)),
    mutation: Object.freeze(sortedCopy(mutation)),
    read_dispatch: Object.freeze(sortedCopy(read_dispatch)),
    discovered_tools: Object.freeze(sortedCopy(discoveredTools)),
    identity_rule_id: IDENTITY_RULE.id,
    completeness_method: IDENTITY_RULE.completeness_method,
    note: 'Independently enumerated from registrations + acquisition sites; not frozen constants',
  });
}

/**
 * Bidirectional exact-set compare between independently enumerated source IDs
 * and the separate frozen specification.
 */
function compareEnumeratedToFrozenSpec(enumerated, frozen) {
  if (!enumerated || enumerated.ok !== true) {
    return failClosed('source_enumeration_failed', (enumerated && enumerated.errors) || [
      'enumeration required',
    ]);
  }
  if (!frozen || frozen.ok !== true) {
    return failClosed('frozen_specification_missing', (frozen && frozen.errors) || [
      'frozen specification required',
    ]);
  }

  const errors = [];
  const pairs = [
    ['whatsapp_send', enumerated.whatsapp_send, frozen.whatsapp_send],
    ['mutation', enumerated.mutation, frozen.mutation],
    ['read_dispatch', enumerated.read_dispatch, frozen.read_dispatch],
  ];
  for (const [label, left, right] of pairs) {
    if (!setsEqual(left, right)) {
      const onlyLeft = setDiff(left, right);
      const onlyRight = setDiff(right, left);
      if (onlyLeft.length) {
        errors.push(`${label}_only_in_source:${onlyLeft.join(',')}`);
      }
      if (onlyRight.length) {
        errors.push(`${label}_only_in_frozen:${onlyRight.join(',')}`);
      }
      if (!onlyLeft.length && !onlyRight.length) {
        errors.push(`${label}_set_mismatch`);
      }
    }
  }

  if (errors.length) {
    return failClosed(errors[0], errors);
  }

  return Object.freeze({
    ok: true,
    code: 'bidirectional_source_frozen_exact_set_accepted',
    counts: { ...frozen.counts },
    completeness_method: IDENTITY_RULE.completeness_method,
  });
}

/**
 * Compare inventory adapter IDs to independently enumerated source IDs and the
 * separate frozen specification (bidirectional). Rejects self-reported
 * completeness flags as authority. Does not treat implementation constants as
 * the expected set.
 */
function compareInventoryExactSet(inventory, rootDir) {
  const enumerated = enumerateCapabilityIdsFromSource(rootDir);
  if (!enumerated.ok) {
    return failClosed('source_enumeration_failed', enumerated.errors);
  }
  const frozen = loadFrozenCapabilityIds(rootDir);
  if (!frozen.ok) {
    return failClosed('frozen_specification_missing', frozen.errors);
  }

  const vsFrozen = compareEnumeratedToFrozenSpec(enumerated, frozen);
  if (!vsFrozen.ok) {
    return vsFrozen;
  }

  const inv = inventory || {};
  const sends = (inv.whatsapp_send_adapters || []).map((a) => a.adapter_id);
  const muts = (inv.mutation_adapters || []).map((a) => a.adapter_id);
  const reads = (inv.read_dispatch_adapters || []).map((a) => a.adapter_id);

  const errors = [];
  if (inv.complete === true && inv.completeness_method !== IDENTITY_RULE.completeness_method) {
    errors.push('self_reported_complete_flag_rejected');
  }
  if (inv.completeness_method !== IDENTITY_RULE.completeness_method) {
    errors.push('completeness_method_must_be_source_derived_exact_set_comparison');
  }
  if (inv.identity_rule_id !== IDENTITY_RULE.id) {
    errors.push('identity_rule_id_mismatch');
  }
  if (!setsEqual(sends, enumerated.whatsapp_send) || !setsEqual(sends, frozen.whatsapp_send)) {
    errors.push('whatsapp_send_set_mismatch');
  }
  if (!setsEqual(muts, enumerated.mutation) || !setsEqual(muts, frozen.mutation)) {
    errors.push('mutation_set_mismatch');
  }
  if (!setsEqual(reads, enumerated.read_dispatch) || !setsEqual(reads, frozen.read_dispatch)) {
    errors.push('read_dispatch_set_mismatch');
  }
  for (const extra of DEMONSTRATED_EXTRA_IDS) {
    if (sends.includes(extra) || muts.includes(extra) || reads.includes(extra)) {
      errors.push(`demonstrated_extra_present:${extra}`);
    }
  }
  for (const omit of DEMONSTRATED_OMISSION_IDS) {
    if (!reads.includes(omit)) {
      errors.push(`demonstrated_omission_absent:${omit}`);
    }
  }
  for (const collapsed of COLLAPSED_DUPLICATE_IDS) {
    if (sends.includes(collapsed) || muts.includes(collapsed) || reads.includes(collapsed)) {
      errors.push(`collapsed_duplicate_present:${collapsed}`);
    }
  }

  if (errors.length) {
    return failClosed(errors[0], errors);
  }

  return Object.freeze({
    ok: true,
    code: 'inventory_exact_set_accepted',
    counts: { ...frozen.counts },
    completeness_method: IDENTITY_RULE.completeness_method,
    source_enumeration: 'independent',
    frozen_specification: FROZEN_SPEC_REL,
  });
}

/** @deprecated Use enumerateCapabilityIdsFromSource — kept as alias for call sites. */
function deriveExpectedAdapterIdsFromSource(rootDir, options) {
  return enumerateCapabilityIdsFromSource(rootDir, options);
}

function classifyInventoryDocument(inventory, rootDir) {
  const inv = inventory || {};
  const errors = [];
  const sends = Array.isArray(inv.whatsapp_send_adapters) ? inv.whatsapp_send_adapters : [];
  const muts = Array.isArray(inv.mutation_adapters) ? inv.mutation_adapters : [];
  const reads = Array.isArray(inv.read_dispatch_adapters) ? inv.read_dispatch_adapters : [];

  if (inv.independently_pinned !== true) {
    errors.push('inventory_must_be_independently_pinned');
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
    if (!Array.isArray(a.allowed_tenants) || a.allowed_tenants.length < 1) {
      errors.push(`adapter_missing_allowed_tenants:${a.adapter_id}`);
    } else {
      for (const t of a.allowed_tenants) {
        if (!ALLOWED_TENANTS.includes(t)) {
          errors.push(`adapter_invalid_tenant:${a.adapter_id}:${t}`);
        }
      }
    }
    if (!Array.isArray(a.allowed_locations) || a.allowed_locations.length < 1) {
      errors.push(`adapter_missing_allowed_locations:${a.adapter_id}`);
    } else {
      for (const loc of a.allowed_locations) {
        if (!ALLOWED_LOCATIONS.includes(loc)) {
          errors.push(`adapter_invalid_location:${a.adapter_id}:${loc}`);
        }
      }
      for (const t of a.allowed_tenants || []) {
        const expectedLoc = TENANT_LOCATION[t];
        if (expectedLoc && !a.allowed_locations.includes(expectedLoc)) {
          errors.push(`adapter_tenant_location_gap:${a.adapter_id}:${t}`);
        }
      }
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

  const exact = compareInventoryExactSet(inv, rootDir);
  if (!exact.ok) {
    errors.push(...(exact.errors || [exact.code]));
  }

  if (errors.length) {
    return failClosed(errors[0], errors);
  }

  const frozen = loadFrozenCapabilityIds(rootDir);
  return Object.freeze({
    ok: true,
    code: 'inventory_accepted',
    counts: frozen.ok ? { ...frozen.counts } : undefined,
    completeness_method: IDENTITY_RULE.completeness_method,
  });
}

function classifyCapabilityBoundaryFreeze(candidate) {
  const c = candidate || {};
  if (c.this_slice_implements_runtime === true) {
    return failClosed('runtime_must_not_be_implemented_in_16ae', [
      '16AE is audit-only',
    ]);
  }
  if (c.dispersed_env_checks_as_sole_control === true) {
    return failClosed('dispersed_env_checks_rejected', [
      'central decideCapability is required',
    ]);
  }
  if (c.incomplete_adapter_inventory === true) {
    return failClosed('incomplete_adapter_inventory', [
      'adapter inventory must be complete via source-derived exact-set vs frozen specification',
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
    && c.inventory_lookup_required === true
    && c.effect_from_pinned_entry === true
    && c.exact_tenant_binding === true
    && c.exact_location_binding === true
    && c.immutable_per_turn_decision === true
    && c.immutable_tenant_location_adapter_context === true
    && c.canonical_turn_id_required === true
    && c.per_turn_boundary_object === true
  ) {
    return Object.freeze({
      ok: true,
      code: 'capability_boundary_freeze_accepted',
      note: 'Audit freeze only — runtime owner not wired',
    });
  }
  return failClosed('capability_boundary_freeze_incomplete', [
    'require decideCapability inventory-lookup + tenant/location bind + pinned effect + non-empty turn_id + immutable per-turn tenant/location/adapter boundary deny-send/mutation permit-read before acquisition',
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
  FROZEN_SPEC_REL,
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
  TENANT_WOLFHOUSE,
  TENANT_SUNSET,
  ALLOWED_TENANTS,
  LOCATION_WOLFHOUSE,
  LOCATION_SUNSET,
  ALLOWED_LOCATIONS,
  TENANT_LOCATION,
  IDENTITY_RULE,
  HERMES_TOOL_CLASSIFIERS,
  ACQUISITION_SITE_CLASSIFIERS,
  DEMONSTRATED_OMISSION_IDS,
  DEMONSTRATED_EXTRA_IDS,
  COLLAPSED_DUPLICATE_IDS,
  REQUIRED_SEND_CATEGORIES,
  REQUIRED_MUTATION_CATEGORIES,
  ACQUISITION_KINDS,
  EXPLICITLY_NOT_CLAIMED,
  GATES_UNCHANGED,
  OWNED_RELS,
  MUST_NOT_MUTATE,
  PRESERVED_16U_TRUTHS,
  decideCapability,
  bindTurnBoundary,
  classifyInventoryDocument,
  classifyCapabilityBoundaryFreeze,
  loadFrozenCapabilityIds,
  enumerateCapabilityIdsFromSource,
  deriveExpectedAdapterIdsFromSource,
  compareEnumeratedToFrozenSpec,
  compareInventoryExactSet,
  discoverRegisteredHermesToolNames,
  indexInventoryById,
  rootJoin,
};
