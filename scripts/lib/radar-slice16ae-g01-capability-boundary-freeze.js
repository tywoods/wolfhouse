'use strict';

/**
 * radar-slice16ae-g01-capability-boundary-freeze — RADAR Slice 16AE locks.
 *
 * Audit-only freeze of the central capability boundary required before any
 * G01-A dry-run. Physical acquisition sites are discovered via AST over an
 * explicit production import graph (Python ast; Node Acorn) using primitive
 * kinds + structural site keys. Policy maps discovered site keys → effects.
 * Discovery does not consume adapter IDs.
 *
 * decideCapability: immutable per-turn tenant/location scope + fresh opaque
 * single-use per-decision site grant. Multiple legitimate sites per turn OK;
 * grant reuse / site / effect / context drift fail closed.
 *
 * Does NOT implement runtime behavior, deploy, or live evidence.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const discovery = require('./radar-slice16ae-physical-site-discovery');

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
const SITE_POLICY_REL = 'fixtures/radar-operations/slice16ae-site-policy.json';
const RED_SOURCE_REL = 'fixtures/radar-operations/slice16ae-red-source';

const SUBSCRIPTION_ID = '6dfa56e7-6ca9-49b9-9b32-0c46f704a3b9';

const DECISION_POINT = 'decideCapability';

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
const TENANT_LOCATION = Object.freeze({
  [TENANT_WOLFHOUSE]: LOCATION_WOLFHOUSE,
  [TENANT_SUNSET]: LOCATION_SUNSET,
});

const IDENTITY_RULE = Object.freeze({
  id: 'PHYSICAL_SITE_AST_DISCOVERY_OVER_EXPLICIT_PRODUCTION_IMPORT_GRAPH',
  completeness_method: 'ast_discovered_site_policy_exact_set_comparison',
  exact:
    'Discover physical acquisition sites via AST (Python ast; Node Acorn) over an '
    + 'explicit production import graph using primitive kinds and structural site '
    + 'keys. Policy maps discovered site keys to effects; discovery must not '
    + 'consume adapter IDs. Fail closed on unmatched discovered / stale policy '
    + 'sites, parse / unresolved dynamic imports/calls, and production imports '
    + 'into exclusions. Completeness = bidirectional exact-set equality between '
    + 'reconciled discovery site keys and a separate frozen specification.',
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

const ACQUISITION_KINDS = discovery.PRIMITIVE_KINDS;

const DEMONSTRATED_OMISSION_SITE_SUBSTRINGS = Object.freeze([
  '/sunset/full-day-addon',
  '/sunset/private-lesson',
  '/sunset/joinable-courses',
]);

const DEMONSTRATED_EXTRA_SITE_KEYS = Object.freeze([
  'staff_http_client|docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py|_post_bot|/booking-dry-run',
]);

const COLLAPSED_DUPLICATE_IDS = Object.freeze([
  'hermes_whatsapp_cloud_text_send',
  'hermes_whatsapp_cloud_media_send',
  'hermes_interactive_clarify_send',
  'staff_bot_booking_dry_run',
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
  'site_grant_reuse_accepted',
  'predefined_acquisition_classifiers',
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
  SITE_POLICY_REL,
  RED_SOURCE_REL,
  'scripts/lib/radar-slice16ae-g01-capability-boundary-freeze.js',
  'scripts/lib/radar-slice16ae-physical-site-discovery.js',
  'scripts/lib/radar-slice16ae-scan-python-sites.py',
  'scripts/verify-radar-slice16ae-g01-capability-boundary-freeze.js',
  'docs/RADAR-OPERATIONS-GATE-LEDGER.md',
  'fixtures/radar-operations/gate-matrix.json',
  'fixtures/radar-operations/contract.json',
  'fixtures/radar-operations/findings.md',
  'package.json',
  'package-lock.json',
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

function loadJsonRel(rel, rootDir) {
  const root = rootDir || rootJoin();
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return null;
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

function loadSitePolicy(rootDir) {
  const root = rootDir || rootJoin();
  const abs = path.join(root, SITE_POLICY_REL);
  if (!fs.existsSync(abs)) {
    return failClosed('site_policy_missing', [`missing site policy: ${SITE_POLICY_REL}`]);
  }
  const policy = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (policy.discovery_consumes_adapter_ids === true) {
    return failClosed('policy_feeds_adapter_ids_to_discovery', [
      'policy must not feed adapter IDs into discovery',
    ]);
  }
  return Object.freeze({
    ok: true,
    path: SITE_POLICY_REL,
    policy,
    sites: Object.freeze({ ...(policy.sites || {}) }),
  });
}

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

function indexInventoryBySiteKey(inventory) {
  const map = new Map();
  const inv = inventory || {};
  for (const a of [
    ...(inv.whatsapp_send_adapters || []),
    ...(inv.mutation_adapters || []),
    ...(inv.read_dispatch_adapters || []),
  ]) {
    if (a && a.site_key) map.set(a.site_key, a);
  }
  return map;
}

/** @deprecated adapter_id index retained only for migration RED coverage */
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
 * Bind immutable per-turn tenant/location scope (NOT adapter/site).
 * Multiple legitimate sites per turn are allowed.
 */
function bindTurnScope(decisionContext, priorScope) {
  const turnId = decisionContext && decisionContext.turn_id;
  const tenant = decisionContext && decisionContext.tenant;
  const location = decisionContext && decisionContext.location;

  if (turnId == null || String(turnId).trim() === '') {
    return failClosed('missing_turn_denied', [
      'canonical turn_id required and must be non-empty',
    ]);
  }
  if (tenant == null || tenant === '' || location == null || location === '') {
    return failClosed('missing_turn_context', [
      'per-turn scope requires tenant+location',
    ]);
  }

  const canonicalTurn = String(turnId);
  if (!priorScope) {
    return Object.freeze({
      ok: true,
      turn_id: canonicalTurn,
      tenant,
      location,
      decisions: Object.freeze([]),
    });
  }

  if (
    priorScope.turn_id == null
    || String(priorScope.turn_id).trim() === ''
    || priorScope.tenant == null
    || priorScope.tenant === ''
    || priorScope.location == null
    || priorScope.location === ''
  ) {
    return failClosed('missing_turn_context', [
      'prior per-turn scope missing required turn/tenant/location context',
    ]);
  }
  if (String(priorScope.turn_id) !== canonicalTurn) {
    return failClosed('cross_decision_turn_drift', [
      `turn_id drift: prior=${priorScope.turn_id} current=${canonicalTurn}`,
    ]);
  }
  if (priorScope.tenant !== tenant || priorScope.location !== location) {
    return failClosed('cross_decision_context_drift', [
      `tenant/location drift on turn ${canonicalTurn}: `
        + `prior=${priorScope.tenant}/${priorScope.location} `
        + `current=${tenant}/${location}`,
    ]);
  }

  return Object.freeze({
    ok: true,
    turn_id: canonicalTurn,
    tenant,
    location,
    decisions: Object.freeze([...(priorScope.decisions || [])]),
  });
}

/** Alias retained for verifier compatibility. */
function bindTurnBoundary(decisionContext, priorBoundary) {
  return bindTurnScope(decisionContext, priorBoundary);
}

function mintSiteGrant(payload) {
  const token = crypto.randomBytes(16).toString('hex');
  return Object.freeze({
    token,
    turn_id: payload.turn_id,
    tenant: payload.tenant,
    location: payload.location,
    site_key: payload.site_key,
    effect: payload.effect,
    single_use: true,
    consumed: false,
  });
}

/**
 * Consume an opaque single-use site grant. Fails on reuse, site/effect/context drift.
 */
function consumeSiteGrant(grant, claim, grantRegistry) {
  if (!grant || !grant.token) {
    return failClosed('missing_site_grant', ['site grant required']);
  }
  const reg = grantRegistry || null;
  const live = reg && reg.get ? reg.get(grant.token) : grant;
  if (!live) {
    return failClosed('unknown_site_grant', ['grant token not recognized']);
  }
  if (live.consumed === true) {
    return failClosed('site_grant_reuse', ['opaque site grant is single-use']);
  }
  const c = claim || {};
  if (String(c.site_key || '') !== String(live.site_key)) {
    return failClosed('site_grant_site_drift', [
      `grant site ${live.site_key} != claim ${c.site_key}`,
    ]);
  }
  if (String(c.effect || '') !== String(live.effect)) {
    return failClosed('site_grant_effect_drift', [
      `grant effect ${live.effect} != claim ${c.effect}`,
    ]);
  }
  if (
    String(c.turn_id || '') !== String(live.turn_id)
    || String(c.tenant || '') !== String(live.tenant)
    || String(c.location || '') !== String(live.location)
  ) {
    return failClosed('site_grant_context_drift', [
      'grant turn/tenant/location must match claim',
    ]);
  }

  const consumed = Object.freeze({ ...live, consumed: true });
  if (reg && reg.set) reg.set(grant.token, consumed);
  return Object.freeze({
    ok: true,
    code: 'site_grant_consumed',
    grant: consumed,
  });
}

/**
 * Audit-only central capability decision.
 * Inventory lookup by site_key; effect from pinned entry/policy; immutable
 * per-turn tenant/location scope; fresh opaque single-use site grant.
 */
function decideCapability(candidate, inventory, priorScope, grantRegistry) {
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

  const siteKey = String(c.site_key || '');
  if (!siteKey) {
    return failClosed('unknown_site_denied', [
      'missing site_key denies fail-closed',
    ]);
  }

  const byKey = indexInventoryBySiteKey(inventory);
  const pinned = byKey.get(siteKey);
  if (!pinned) {
    return failClosed('unknown_site_denied', [
      `site_key not in inventory: ${siteKey}`,
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
      `site ${siteKey} not bound to tenant ${tenant}`,
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
      `site ${siteKey} not bound to location ${location}`,
    ]);
  }
  if (TENANT_LOCATION[tenant] !== location) {
    return failClosed('tenant_location_mismatch', [
      `tenant ${tenant} must pair with location ${TENANT_LOCATION[tenant]}; got ${location}`,
    ]);
  }
  if (c.location_confusion === true || c.cross_location === true || c.context_tamper === true) {
    return failClosed('context_tamper_forbidden', [
      'immutable tenant/location context must not be confused or tampered',
    ]);
  }

  const scope = bindTurnScope(
    { turn_id: turnId, tenant, location },
    priorScope,
  );
  if (!scope.ok) return scope;

  const effect = String(pinned.effect || '');
  const capabilityClass = String(pinned.category || pinned.capability_class || '');
  if (!effect || effect === EFFECT_UNKNOWN) {
    return failClosed('unknown_site_denied', [
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
    return failClosed('unknown_site_denied', [
      `unclassified pinned effect=${effect}`,
    ]);
  }

  const grant = mintSiteGrant({
    turn_id: turnId,
    tenant,
    location,
    site_key: siteKey,
    effect,
  });
  if (grantRegistry && grantRegistry.set) {
    grantRegistry.set(grant.token, grant);
  }

  const decisionEntry = Object.freeze({
    site_key: siteKey,
    effect,
    tenant,
    location,
    grant_token: grant.token,
  });
  const boundary = Object.freeze({
    ...scope,
    decisions: Object.freeze([...(scope.decisions || []), decisionEntry]),
  });

  return Object.freeze({
    ok: true,
    fail_closed: true,
    decision,
    code,
    site_key: siteKey,
    adapter_id: pinned.adapter_id || null,
    tenant,
    location,
    turn_id: turnId,
    effect,
    capability_class: capabilityClass,
    inventory_effect: effect,
    caller_effect_ignored: c.effect != null ? String(c.effect) : null,
    site_grant: grant,
    boundary,
    scope: boundary,
    context: Object.freeze({
      tenant,
      location,
      site_key: siteKey,
      turn_id: turnId,
    }),
    note: 'Shape only — runtime not wired in 16AE',
  });
}

/**
 * Independently discover physical site keys via AST; reconcile with policy.
 * Does NOT return frozen/expected constants and does not consume adapter IDs.
 */
function enumerateCapabilityIdsFromSource(rootDir, options) {
  const opts = options || {};
  const root = rootDir || rootJoin();
  const discovered = discovery.discoverPhysicalSites(root, opts);
  if (!discovered.ok) {
    return failClosed('discovery_fail_closed', discovered.errors || ['discovery_failed']);
  }

  // Adversarial: inject extra discovered site keys (unmatched vs policy)
  const injected = [...(opts.inject_discovered_site_keys || [])];
  const forceOmit = new Set(opts.force_omit_site_keys || []);

  const policyLoad = loadSitePolicy(root);
  if (!policyLoad.ok) return policyLoad;

  const policy = policyLoad.policy;

  // force_omit_site_keys simulates a source acquisition omission: site absent from
  // discovery while still present in policy → stale_policy / acquisition_site_omission.
  let siteKeys = discovered.site_keys.filter((k) => !forceOmit.has(k));
  siteKeys = [...siteKeys, ...injected];
  const syntheticDiscovery = Object.freeze({
    ...discovered,
    ok: true,
    site_keys: Object.freeze(sortedCopy(siteKeys)),
    sites: Object.freeze([
      ...discovered.sites.filter((s) => !forceOmit.has(s.site_key)),
      ...injected.map((k) => ({ site_key: k, primitive_kind: 'staff_http_client' })),
    ]),
  });

  const reconciled = discovery.reconcileDiscoveryWithPolicy(syntheticDiscovery, policy);
  if (!reconciled.ok) {
    // Map unmatched injected keys to unclassified capability RED wording
    const errors = (reconciled.errors || []).map((e) => {
      if (e.startsWith('unmatched_discovered_site:')) {
        return `newly_discovered_unmatched_site:${e.slice('unmatched_discovered_site:'.length)}`;
      }
      if (e.startsWith('stale_policy_site:')) {
        return `acquisition_site_omission:${e.slice('stale_policy_site:'.length)}`;
      }
      return e;
    });
    return failClosed(errors[0].split(':')[0], errors);
  }

  return Object.freeze({
    ok: true,
    code: 'source_enumeration_accepted',
    whatsapp_send: reconciled.by_effect.whatsapp_send,
    mutation: reconciled.by_effect.mutation,
    read_dispatch: reconciled.by_effect.read_dispatch,
    discovered_site_keys: Object.freeze(sortedCopy(discovered.site_keys)),
    identity_rule_id: IDENTITY_RULE.id,
    completeness_method: IDENTITY_RULE.completeness_method,
    scanner_counts: discovered.scanner_counts,
    discovery_consumes_adapter_ids: false,
    note: 'Independently AST-discovered physical sites reconciled to policy; not frozen constants',
  });
}

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
      if (onlyLeft.length) errors.push(`${label}_only_in_source:${onlyLeft.join(',')}`);
      if (onlyRight.length) errors.push(`${label}_only_in_frozen:${onlyRight.join(',')}`);
      if (!onlyLeft.length && !onlyRight.length) errors.push(`${label}_set_mismatch`);
    }
  }
  if (errors.length) return failClosed(errors[0], errors);

  return Object.freeze({
    ok: true,
    code: 'bidirectional_source_frozen_exact_set_accepted',
    counts: { ...frozen.counts },
    completeness_method: IDENTITY_RULE.completeness_method,
    scanner_counts: enumerated.scanner_counts,
  });
}

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
  if (!vsFrozen.ok) return vsFrozen;

  const inv = inventory || {};
  const sends = (inv.whatsapp_send_adapters || []).map((a) => a.site_key);
  const muts = (inv.mutation_adapters || []).map((a) => a.site_key);
  const reads = (inv.read_dispatch_adapters || []).map((a) => a.site_key);

  const errors = [];
  if (inv.complete === true && inv.completeness_method !== IDENTITY_RULE.completeness_method) {
    errors.push('self_reported_complete_flag_rejected');
  }
  if (inv.completeness_method !== IDENTITY_RULE.completeness_method) {
    errors.push('completeness_method_must_be_ast_discovered_site_policy_exact_set_comparison');
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
  for (const extra of DEMONSTRATED_EXTRA_SITE_KEYS) {
    if (sends.includes(extra) || muts.includes(extra) || reads.includes(extra)) {
      errors.push(`demonstrated_extra_present:${extra}`);
    }
  }
  for (const needle of DEMONSTRATED_OMISSION_SITE_SUBSTRINGS) {
    if (!reads.some((k) => String(k).includes(needle))) {
      errors.push(`demonstrated_omission_absent:${needle}`);
    }
  }
  for (const collapsed of COLLAPSED_DUPLICATE_IDS) {
    if (sends.includes(collapsed) || muts.includes(collapsed) || reads.includes(collapsed)) {
      errors.push(`collapsed_duplicate_present:${collapsed}`);
    }
  }

  if (errors.length) return failClosed(errors[0], errors);

  return Object.freeze({
    ok: true,
    code: 'inventory_exact_set_accepted',
    counts: { ...frozen.counts },
    completeness_method: IDENTITY_RULE.completeness_method,
    source_enumeration: 'independent_ast_discovery',
    frozen_specification: FROZEN_SPEC_REL,
    scanner_counts: enumerated.scanner_counts,
  });
}

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

  const keys = [];
  for (const a of [...sends, ...muts, ...reads]) {
    if (!a || !a.site_key) {
      errors.push('adapter_missing_site_key');
      continue;
    }
    keys.push(a.site_key);
    if (!a.path || !a.symbol) {
      errors.push(`adapter_pin_incomplete:${a.site_key}`);
    }
    if (!a.acquisition_point || !a.category || !a.effect || !a.primitive_kind) {
      errors.push(`adapter_fields_incomplete:${a.site_key}`);
    }
    if (!Array.isArray(a.allowed_tenants) || a.allowed_tenants.length < 1) {
      errors.push(`adapter_missing_allowed_tenants:${a.site_key}`);
    } else {
      for (const t of a.allowed_tenants) {
        if (!ALLOWED_TENANTS.includes(t)) {
          errors.push(`adapter_invalid_tenant:${a.site_key}:${t}`);
        }
      }
    }
    if (!Array.isArray(a.allowed_locations) || a.allowed_locations.length < 1) {
      errors.push(`adapter_missing_allowed_locations:${a.site_key}`);
    } else {
      for (const loc of a.allowed_locations) {
        if (!ALLOWED_LOCATIONS.includes(loc)) {
          errors.push(`adapter_invalid_location:${a.site_key}:${loc}`);
        }
      }
      for (const t of a.allowed_tenants || []) {
        const expectedLoc = TENANT_LOCATION[t];
        if (expectedLoc && !a.allowed_locations.includes(expectedLoc)) {
          errors.push(`adapter_tenant_location_gap:${a.site_key}:${t}`);
        }
      }
    }
  }

  const seen = new Set();
  for (const id of keys) {
    if (seen.has(id)) errors.push(`duplicate_site_key:${id}`);
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

  if (errors.length) return failClosed(errors[0], errors);

  const frozen = loadFrozenCapabilityIds(rootDir);
  return Object.freeze({
    ok: true,
    code: 'inventory_accepted',
    counts: frozen.ok ? { ...frozen.counts } : undefined,
    completeness_method: IDENTITY_RULE.completeness_method,
    scanner_counts: exact.scanner_counts,
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
      'site inventory must be complete via AST discovery vs policy vs frozen specification',
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
    && c.immutable_tenant_location_scope === true
    && c.fresh_opaque_single_use_site_grant === true
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
    'require decideCapability site-key lookup + tenant/location scope + pinned effect + non-empty turn_id + fresh single-use site grant deny-send/mutation permit-read before acquisition',
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
  SITE_POLICY_REL,
  RED_SOURCE_REL,
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
  DEMONSTRATED_OMISSION_SITE_SUBSTRINGS,
  DEMONSTRATED_EXTRA_SITE_KEYS,
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
  bindTurnScope,
  bindTurnBoundary,
  mintSiteGrant,
  consumeSiteGrant,
  classifyInventoryDocument,
  classifyCapabilityBoundaryFreeze,
  loadFrozenCapabilityIds,
  loadSitePolicy,
  enumerateCapabilityIdsFromSource,
  deriveExpectedAdapterIdsFromSource,
  compareEnumeratedToFrozenSpec,
  compareInventoryExactSet,
  indexInventoryBySiteKey,
  indexInventoryById,
  rootJoin,
  discovery,
};
