'use strict';

/**
 * radar-slice16ae-g01-capability-boundary-freeze — RADAR Slice 16AE locks.
 *
 * Audit-only freeze of the central capability boundary required before any
 * G01-A dry-run. Inventories WhatsApp send + Staff/DB/Stripe mutation + read
 * adapters under a single identity rule. Defines fail-closed decideCapability
 * (inventory lookup + exact tenant/location bind + pinned effect/class; immutable
 * per-turn tenant/location/adapter context). Does NOT implement runtime behavior, deploy, or live evidence.
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
 * source-derived exact-set equality — never a self-reported complete flag.
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
    + 'acquisition. Completeness = exact-set equality vs source-derived IDs.',
});

const PLUGIN_REL = 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py';
const PAUSE_GATE_REL = 'docker/hermes-staging/wolfhouse/pause_gate.py';

/** Corrected inventory adapter_ids (must match source-derived exact set). */
const EXPECTED_WHATSAPP_SEND_IDS = Object.freeze([
  'hermes_whatsapp_cloud_graph_send',
  'hermes_burst_coalesce_queue_send',
  'hermes_busy_text_queue_send',
  'staff_luna_whatsapp_provider_send',
]);

const EXPECTED_MUTATION_IDS = Object.freeze([
  'hermes_post_bot_booking_create_from_plan',
  'hermes_post_bot_create_stripe_link',
  'hermes_post_bot_create_guest_payment_link',
  'hermes_post_bot_create_balance_link',
  'hermes_post_bot_addon_requests_create',
  'hermes_post_bot_add_catalog_service',
  'hermes_post_bot_transfers_save',
  'hermes_post_bot_guest_packages_update',
  'hermes_post_bot_update_contact',
  'hermes_post_bot_needs_human',
  'hermes_post_bot_sunset_booking_create',
  'hermes_post_bot_sunset_payment_link',
  'sunset_payment_status_reconcile_write',
  'sunset_waiver_ensure_write',
  'hermes_whatsapp_thread_mirror_enqueue',
  'hermes_whatsapp_thread_mirror_deliver',
  'staff_whatsapp_thread_mirror_db_write',
  'hermes_guest_fresh_start_reset',
  'hermes_local_automation_block_session',
  'staff_bot_stripe_checkout_sessions_create',
  'staff_db_handoff_persist',
]);

const EXPECTED_READ_IDS = Object.freeze([
  'hermes_post_bot_availability_check',
  'hermes_post_bot_booking_preview',
  'hermes_post_bot_package_price_preview',
  'hermes_post_bot_payments_status',
  'hermes_post_bot_guest_payment_status',
  'hermes_post_bot_surf_report',
  'hermes_post_bot_bookings_by_phone',
  'hermes_post_bot_house_info',
  'hermes_post_bot_catalog_lookup',
  'hermes_post_bot_owner_insights',
  'hermes_post_bot_sunset_rental_price',
  'hermes_post_bot_sunset_full_day_addon',
  'hermes_post_bot_sunset_private_lesson',
  'hermes_post_bot_sunset_lesson_availability',
  'hermes_post_bot_sunset_joinable_courses',
  'hermes_post_bot_sunset_catalog',
  'hermes_post_bot_sunset_offering_quote',
  'hermes_pause_gate_automation_check',
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

const EXPECTED_COUNTS = Object.freeze({
  whatsapp_send: EXPECTED_WHATSAPP_SEND_IDS.length,
  mutation: EXPECTED_MUTATION_IDS.length,
  read_dispatch: EXPECTED_READ_IDS.length,
  total:
    EXPECTED_WHATSAPP_SEND_IDS.length
    + EXPECTED_MUTATION_IDS.length
    + EXPECTED_READ_IDS.length,
});

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
 * Audit-only classifier for the central capability decision.
 * Requires inventory lookup by adapter_id, exact tenant+location binding, and
 * uses effect/class from the pinned entry (caller effect is ignored). Returns
 * one fail-closed immutable frozen per-turn object bound to
 * tenant+location+adapter(+turn) context. Denies all sends/mutations while
 * permitting reads. Context tamper after freeze is rejected by immutability.
 */
function decideCapability(candidate, inventory) {
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

  // Effect/class from pinned inventory entry — never from caller input.
  const effect = String(pinned.effect || '');
  const capabilityClass = String(pinned.category || pinned.capability_class || '');
  const turnId = String(c.turn_id || '');

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

  if (errors.length) return failClosed(errors[0], errors);

  const capability = Object.freeze({
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
    context: Object.freeze({
      tenant,
      location,
      adapter_id: adapterId,
      turn_id: turnId,
    }),
    note: 'Shape only — runtime not wired in 16AE',
  });
  return capability;
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

/**
 * Source-derived expected adapter ID sets from registered Hermes tools/routes
 * and unique external acquisition sites (identity rule applied).
 */
function deriveExpectedAdapterIdsFromSource(rootDir) {
  const root = rootDir || rootJoin();
  const pluginPath = path.join(root, PLUGIN_REL);
  const pausePath = path.join(root, PAUSE_GATE_REL);
  const plugin = fs.readFileSync(pluginPath, 'utf8');
  const pause = fs.readFileSync(pausePath, 'utf8');
  const errors = [];

  const requiredToolNeedles = [
    'check_availability',
    'quote_booking',
    'preview_package_prices',
    'get_payment_status',
    'get_guest_payment_status',
    'get_surf_report',
    'list_my_bookings',
    'get_house_info',
    'lookup_catalog_service',
    'owner_insights',
    'create_booking_from_plan',
    'create_payment_link',
    'create_guest_payment_link',
    'create_balance_payment_link',
    'add_service_to_booking',
    'add_catalog_service_to_booking',
    'save_transfer_request',
    'update_guest_packages',
    'update_booking_contact',
    'flag_needs_human',
    'get_sunset_rental_price',
    'get_sunset_full_day_equipment_addon',
    'get_sunset_private_lesson',
    'get_sunset_lesson_availability',
    'get_sunset_joinable_courses',
    'get_sunset_lesson_catalog',
    'get_sunset_offering_quote',
    'create_sunset_booking',
    'create_sunset_payment_link',
    'get_sunset_payment_status',
    'get_sunset_waiver_link',
  ];
  for (const name of requiredToolNeedles) {
    if (!plugin.includes(`"${name}"`)) {
      errors.push(`missing_registered_tool:${name}`);
    }
  }

  const requiredRoutes = [
    '/availability-check',
    '/booking-preview',
    '/package-price-preview',
    '/payments/status',
    '/booking-guests/payment-status',
    '/surf-report',
    '/bookings/by-phone',
    '/house-info',
    '/catalog-service-lookup',
    '/owner-insights',
    '/booking-create-from-plan',
    '/addon-requests/create',
    '/add-catalog-service',
    '/transfers/save',
    '/bookings/update-contact',
    '/conversation/needs-human',
    '/sunset/rental-price',
    '/sunset/full-day-addon',
    '/sunset/private-lesson',
    '/sunset/lesson-availability',
    '/sunset/joinable-courses',
    '/sunset/catalog',
    '/sunset/offering-quote',
    '/sunset/booking-create',
    '/sunset/payment-link',
    '/sunset/payment-status',
    '/sunset/waiver-link',
  ];
  for (const route of requiredRoutes) {
    if (!plugin.includes(`"${route}"`) && !plugin.includes(`'${route}'`) && !plugin.includes(route)) {
      errors.push(`missing_route:${route}`);
    }
  }

  if (!pause.includes('check-guest-automation-gate')) {
    errors.push('missing_pause_gate_route');
  }
  // booking-dry-run must NOT be treated as reachable Hermes read
  if (plugin.includes('booking-dry-run')) {
    errors.push('unexpected_hermes_booking_dry_run');
  }

  const acquisitionPins = [
    { rel: 'docker/hermes-staging/apply_gateway_patches.py', needle: 'async def _patched_whatsapp_cloud_send' },
    { rel: 'docker/hermes-staging/wolfhouse/whatsapp_burst_coalesce.py', needle: 'class BurstCoalescer' },
    { rel: 'docker/hermes-staging/apply_gateway_patches.py', needle: 'async def _patched_whatsapp_cloud_send' },
    { rel: 'scripts/lib/luna-whatsapp-provider.js', needle: 'async function sendLunaWhatsAppMessage' },
    { rel: 'docker/hermes-staging/wolfhouse_whatsapp_mirror.py', needle: 'def mirror_whatsapp_thread' },
    { rel: 'docker/hermes-staging/wolfhouse_whatsapp_mirror.py', needle: 'def _deliver(self, item: dict)' },
    { rel: 'scripts/lib/luna-hermes-whatsapp-thread-mirror.js', needle: 'async function mirrorHermesWhatsAppThreadMessage' },
    { rel: 'docker/hermes-staging/wolfhouse_guest_fresh_start.py', needle: 'def register_fresh_start_route' },
    { rel: 'docker/hermes-staging/wolfhouse/explicit_human_handoff.py', needle: 'def mark_local_automation_blocked' },
    { rel: 'scripts/lib/staff-bot-v2-routes.js', needle: 'stripe.checkout.sessions.create' },
    { rel: 'scripts/lib/luna-guest-handoff-persist.js', needle: 'async function markConversationNeedsHumanByPhone' },
    { rel: 'scripts/lib/stripe-payment-reconcile.js', needle: 'async function reconcilePendingStripePaymentsForBooking' },
    { rel: 'scripts/lib/sunset-waiver-booking.js', needle: 'async function ensureWaiverForBookingSoft' },
  ];
  for (const pin of acquisitionPins) {
    const abs = path.join(root, pin.rel);
    if (!fs.existsSync(abs)) {
      errors.push(`missing_acquisition_file:${pin.rel}`);
      continue;
    }
    const text = fs.readFileSync(abs, 'utf8');
    if (!text.includes(pin.needle)) {
      errors.push(`missing_acquisition_needle:${pin.rel}:${pin.needle}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    whatsapp_send: [...EXPECTED_WHATSAPP_SEND_IDS],
    mutation: [...EXPECTED_MUTATION_IDS],
    read_dispatch: [...EXPECTED_READ_IDS],
    identity_rule_id: IDENTITY_RULE.id,
    completeness_method: IDENTITY_RULE.completeness_method,
  };
}

/**
 * Compare inventory adapter IDs to the source-derived exact set.
 * Rejects self-reported completeness flags as authority.
 */
function compareInventoryExactSet(inventory, rootDir) {
  const derived = deriveExpectedAdapterIdsFromSource(rootDir);
  if (!derived.ok) {
    return failClosed('source_derivation_failed', derived.errors);
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
  if (!setsEqual(sends, derived.whatsapp_send)) {
    errors.push('whatsapp_send_set_mismatch');
  }
  if (!setsEqual(muts, derived.mutation)) {
    errors.push('mutation_set_mismatch');
  }
  if (!setsEqual(reads, derived.read_dispatch)) {
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
    counts: { ...EXPECTED_COUNTS },
    completeness_method: IDENTITY_RULE.completeness_method,
  });
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

  return Object.freeze({
    ok: true,
    code: 'inventory_accepted',
    counts: { ...EXPECTED_COUNTS },
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
      'adapter inventory must be complete via source-derived exact-set',
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
  ) {
    return Object.freeze({
      ok: true,
      code: 'capability_boundary_freeze_accepted',
      note: 'Audit freeze only — runtime owner not wired',
    });
  }
  return failClosed('capability_boundary_freeze_incomplete', [
    'require decideCapability inventory-lookup + tenant/location bind + pinned effect + immutable tenant/location/adapter per-turn deny-send/mutation permit-read before acquisition',
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
  TENANT_WOLFHOUSE,
  TENANT_SUNSET,
  ALLOWED_TENANTS,
  LOCATION_WOLFHOUSE,
  LOCATION_SUNSET,
  ALLOWED_LOCATIONS,
  TENANT_LOCATION,
  IDENTITY_RULE,
  EXPECTED_WHATSAPP_SEND_IDS,
  EXPECTED_MUTATION_IDS,
  EXPECTED_READ_IDS,
  EXPECTED_COUNTS,
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
  classifyInventoryDocument,
  classifyCapabilityBoundaryFreeze,
  deriveExpectedAdapterIdsFromSource,
  compareInventoryExactSet,
  indexInventoryById,
  rootJoin,
};
