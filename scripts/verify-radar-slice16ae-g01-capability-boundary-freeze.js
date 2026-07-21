'use strict';

/**
 * verify:radar-slice16ae-g01-capability-boundary-freeze — RADAR Slice 16AE
 *
 * Offline RED/GREEN for audit-only central capability boundary freeze.
 * AST physical-site discovery + site-grant semantics. No network / live / runtime wiring.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16ae-g01-capability-boundary-freeze');
const discovery = require('./lib/radar-slice16ae-physical-site-discovery');

const frozenSpec = locks.loadFrozenCapabilityIds(ROOT);
if (!frozenSpec.ok) {
  console.error('FATAL: frozen capability specification missing', frozenSpec);
  process.exit(1);
}
const FROZEN_COUNTS = frozenSpec.counts;

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

function firstSite(inventory, effect) {
  const list = effect === 'whatsapp_send'
    ? inventory.whatsapp_send_adapters
    : effect === 'mutation'
      ? inventory.mutation_adapters
      : inventory.read_dispatch_adapters;
  return list[0];
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Build a temp tree overlaying a RED-mutated graph node for real source-mutation proofs.
 */
function withMutatedGraphOverlay(mutateFn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '16ae-red-'));
  try {
    // Minimal graph: copy required scanner + a few production files then mutate
    const nodes = [
      ...discovery.JS_GRAPH_NODES,
      'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py',
      'docker/hermes-staging/apply_gateway_patches.py',
      'docker/hermes-staging/wolfhouse_whatsapp_mirror.py',
      'docker/hermes-staging/wolfhouse_guest_fresh_start.py',
      'docker/hermes-staging/wolfhouse/pause_gate.py',
      'docker/hermes-staging/wolfhouse/explicit_human_handoff.py',
      'docker/hermes-staging/wolfhouse/whatsapp_burst_coalesce.py',
      locks.SITE_POLICY_REL,
      locks.FROZEN_SPEC_REL,
      'scripts/lib/radar-slice16ae-scan-python-sites.py',
    ];
    for (const rel of nodes) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      const dest = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
    }
    mutateFn(tmp);
    return mutateFn._result ? mutateFn._result(tmp) : discovery.discoverPhysicalSites(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('RADAR 16AE capability boundary freeze — offline verifier\n');

const design = readJson(locks.DESIGN_REL);
const inventory = readJson(locks.INVENTORY_REL);
const contract = readJson(locks.CONTRACT_REL);
const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
const opsContract = readJson('fixtures/radar-operations/contract.json');
const ledger = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
const findings = readText('fixtures/radar-operations/findings.md');
const policyLoad = locks.loadSitePolicy(ROOT);

green('fixtures_present',
  fs.existsSync(path.join(ROOT, locks.DESIGN_REL))
  && fs.existsSync(path.join(ROOT, locks.INVENTORY_REL))
  && fs.existsSync(path.join(ROOT, locks.CONTRACT_REL))
  && fs.existsSync(path.join(ROOT, locks.FROZEN_SPEC_REL))
  && fs.existsSync(path.join(ROOT, locks.SITE_POLICY_REL))
  && fs.existsSync(path.join(ROOT, locks.RED_SOURCE_REL)));

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
  && frozenSpec.identity_rule_id === locks.IDENTITY_RULE.id);

green('contract_pins',
  contract.outcome_id === locks.OUTCOME_ID
  && contract.required_design_facts.whatsapp_send_count === FROZEN_COUNTS.whatsapp_send
  && contract.required_design_facts.mutation_count === FROZEN_COUNTS.mutation
  && contract.required_design_facts.read_dispatch_count === FROZEN_COUNTS.read_dispatch
  && contract.required_design_facts.total_count === FROZEN_COUNTS.total
  && contract.required_design_facts.discovery_consumes_adapter_ids === false
  && contract.required_design_facts.fresh_opaque_single_use_site_grant === true
  && contract.verdict_policy.proven === 0
  && contract.verdict_policy.partial === 9);

green('inventory_pins',
  inventory.counts.whatsapp_send === FROZEN_COUNTS.whatsapp_send
  && inventory.counts.mutation === FROZEN_COUNTS.mutation
  && inventory.counts.read_dispatch === FROZEN_COUNTS.read_dispatch
  && inventory.counts.total === FROZEN_COUNTS.total
  && inventory.independently_pinned === true);

green('frozen_specification_loaded',
  frozenSpec.ok === true
  && frozenSpec.counts.total === FROZEN_COUNTS.total);

green('site_policy_loaded',
  policyLoad.ok === true
  && policyLoad.policy.discovery_consumes_adapter_ids === false);

const invClass = locks.classifyInventoryDocument(inventory, ROOT);
green('inventory_classifier_accepts', invClass.ok === true, JSON.stringify(invClass));

const exact = locks.compareInventoryExactSet(inventory, ROOT);
green('source_derived_exact_set', exact.ok === true, JSON.stringify(exact));

const enumerated = locks.enumerateCapabilityIdsFromSource(ROOT);
green('source_enumeration_independent',
  enumerated.ok === true
  && enumerated.discovery_consumes_adapter_ids === false
  && enumerated.note
  && /AST-discovered/i.test(enumerated.note)
  && !Object.prototype.hasOwnProperty.call(locks, 'HERMES_TOOL_CLASSIFIERS')
  && !Object.prototype.hasOwnProperty.call(locks, 'ACQUISITION_SITE_CLASSIFIERS')
  && !Object.prototype.hasOwnProperty.call(locks, 'EXPECTED_WHATSAPP_SEND_IDS'),
  (enumerated.errors || []).slice(0, 6).join(' | '));

green('bidirectional_exact_set',
  (() => {
    if (!enumerated.ok) return false;
    const vsFrozen = locks.compareEnumeratedToFrozenSpec(enumerated, frozenSpec);
    return vsFrozen.ok === true;
  })());

green('scanner_counts_present',
  enumerated.ok
  && enumerated.scanner_counts
  && enumerated.scanner_counts.total_sites === FROZEN_COUNTS.total
  && enumerated.scanner_counts.python_sites > 0
  && enumerated.scanner_counts.javascript_sites > 0,
  JSON.stringify(enumerated.scanner_counts));

green('source_derivation_ok', enumerated.ok === true, (enumerated.errors || []).slice(0, 6).join(' | '));

green('no_predefined_acquisition_classifiers',
  !fs.readFileSync(path.join(ROOT, 'scripts/lib/radar-slice16ae-g01-capability-boundary-freeze.js'), 'utf8')
    .includes('HERMES_TOOL_CLASSIFIERS')
  && !fs.readFileSync(path.join(ROOT, 'scripts/lib/radar-slice16ae-g01-capability-boundary-freeze.js'), 'utf8')
    .includes('ACQUISITION_SITE_CLASSIFIERS'));

const readSite = firstSite(inventory, 'read_dispatch');
const sendSite = firstSite(inventory, 'whatsapp_send');
const mutSite = firstSite(inventory, 'mutation');

green('central_decision_point_frozen',
  design.central_capability_boundary
  && design.central_capability_boundary.decision_point === locks.DECISION_POINT
  && design.central_capability_boundary.decision_before_acquisition === true
  && design.central_capability_boundary.immutable_tenant_location_scope === true
  && design.central_capability_boundary.fresh_opaque_single_use_site_grant === true
  && design.central_capability_boundary.discovery_consumes_adapter_ids === false);

const designClass = locks.classifyCapabilityBoundaryFreeze({
  ...design.central_capability_boundary,
  central_decision_point: locks.DECISION_POINT,
  incomplete_adapter_inventory: false,
});
green('design_freeze_classifier_accepts', designClass.ok === true, JSON.stringify(designClass));

const grantRegistry = new Map();
const permit = locks.decideCapability({
  site_key: readSite.site_key,
  tenant: readSite.allowed_tenants[0],
  location: readSite.allowed_locations[0],
  turn_id: 'turn-read-1',
  effect: 'mutation', // spoof ignored
}, inventory, null, grantRegistry);
green('decide_permits_read',
  permit.ok === true
  && permit.decision === 'permit'
  && permit.effect === 'read_dispatch'
  && permit.caller_effect_ignored === 'mutation'
  && permit.site_grant
  && permit.site_grant.token
  && permit.site_grant.single_use === true);

green('decide_multi_site_same_turn',
  (() => {
    const reg = new Map();
    const first = locks.decideCapability({
      site_key: readSite.site_key,
      tenant: locks.TENANT_WOLFHOUSE,
      location: locks.LOCATION_WOLFHOUSE,
      turn_id: 'turn-multi-1',
    }, inventory, null, reg);
    // pick another wolfhouse read if possible
    const secondRead = inventory.read_dispatch_adapters.find(
      (a) => a.site_key !== readSite.site_key
        && a.allowed_tenants.includes(locks.TENANT_WOLFHOUSE)
        && a.allowed_locations.includes(locks.LOCATION_WOLFHOUSE),
    ) || readSite;
    const second = locks.decideCapability({
      site_key: secondRead.site_key,
      tenant: locks.TENANT_WOLFHOUSE,
      location: locks.LOCATION_WOLFHOUSE,
      turn_id: 'turn-multi-1',
    }, inventory, first.boundary, reg);
    return first.ok === true
      && second.ok === true
      && first.site_grant.token !== second.site_grant.token
      && second.boundary.decisions.length === 2;
  })());

green('decide_denies_whatsapp_send',
  (() => {
    const r = locks.decideCapability({
      site_key: sendSite.site_key,
      tenant: sendSite.allowed_tenants[0],
      location: sendSite.allowed_locations[0],
      turn_id: 'turn-send-1',
    }, inventory);
    return r.ok === true && r.decision === 'deny' && r.code === 'deny_whatsapp_send';
  })());

green('decide_denies_mutation',
  (() => {
    const r = locks.decideCapability({
      site_key: mutSite.site_key,
      tenant: mutSite.allowed_tenants[0],
      location: mutSite.allowed_locations[0],
      turn_id: 'turn-mut-1',
    }, inventory);
    return r.ok === true && r.decision === 'deny' && r.code === 'deny_mutation';
  })());

green('later_owner_specified_not_created',
  design.later_implementation_owner
  && design.later_implementation_owner.primary.module === locks.LATER_OWNER_MODULE
  && !fs.existsSync(path.join(ROOT, locks.LATER_OWNER_MODULE))
  && !fs.existsSync(path.join(ROOT, locks.LATER_STAFF_OWNER_MODULE)));

green('dry_run_still_not_implementable',
  design.dry_run_status
  && design.dry_run_status.implementable_today === false
  && contract.required_design_facts.dry_run_implementable_today === false);

green('next_slice_runtime_apply',
  design.smallest_implementation_slice_after_freeze
  && design.smallest_implementation_slice_after_freeze.id === locks.NEXT_SLICE_ID);

green('preserved_16u_provenance',
  design.preserved_16u_provenance
  && design.preserved_16u_provenance.burst_provenance
    === locks.PRESERVED_16U_TRUTHS.burst_provenance
  && design.preserved_16u_provenance.g01b_correlation_today
    === locks.PRESERVED_16U_TRUTHS.g01b_correlation_today);

green('required_categories_covered',
  locks.REQUIRED_SEND_CATEGORIES.every((c) => inventory.whatsapp_send_adapters.some((a) => a.category === c))
  && locks.REQUIRED_MUTATION_CATEGORIES.every((c) => inventory.mutation_adapters.some((a) => a.category === c)));

green('demonstrated_reads_present',
  locks.DEMONSTRATED_OMISSION_SITE_SUBSTRINGS.every((n) => inventory.read_dispatch_adapters.some((a) => a.site_key.includes(n))));

green('demonstrated_extra_absent',
  locks.DEMONSTRATED_EXTRA_SITE_KEYS.every((k) => !inventory.read_dispatch_adapters.some((a) => a.site_key === k)
    && !inventory.mutation_adapters.some((a) => a.site_key === k)
    && !inventory.whatsapp_send_adapters.some((a) => a.site_key === k)));

// --- RED ---
red('reject_omission',
  locks.classifyInventoryDocument({ ...inventory, omits_known_reachable_adapter: true }, ROOT).ok === false);

red('reject_self_reported_complete_flag',
  locks.classifyInventoryDocument({
    ...inventory,
    complete: true,
    completeness_method: 'self_reported',
  }, ROOT).ok === false);

red('reject_demonstrated_omission',
  (() => {
    const truncated = {
      ...inventory,
      read_dispatch_adapters: inventory.read_dispatch_adapters.filter(
        (a) => !a.site_key.includes('/sunset/full-day-addon'),
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
    const extra = {
      ...inventory,
      read_dispatch_adapters: [
        ...inventory.read_dispatch_adapters,
        {
          ...readSite,
          site_key: locks.DEMONSTRATED_EXTRA_SITE_KEYS[0],
          adapter_id: 'staff_bot_booking_dry_run',
        },
      ],
    };
    return locks.compareInventoryExactSet(extra, ROOT).ok === false;
  })());

red('reject_collapsed_duplicate_present',
  (() => {
    const extra = {
      ...inventory,
      whatsapp_send_adapters: [
        ...inventory.whatsapp_send_adapters,
        { ...sendSite, site_key: 'hermes_whatsapp_cloud_text_send', adapter_id: 'hermes_whatsapp_cloud_text_send' },
      ],
    };
    return locks.compareInventoryExactSet(extra, ROOT).ok === false;
  })());

red('reject_duplicate_site_keys',
  (() => {
    const dup = {
      ...inventory,
      read_dispatch_adapters: [...inventory.read_dispatch_adapters, { ...readSite }],
    };
    return locks.classifyInventoryDocument(dup, ROOT).ok === false;
  })());

red('reject_dispersed_env_checks',
  locks.decideCapability({
    site_key: readSite.site_key,
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    dispersed_env_checks_as_sole_control: true,
  }, inventory).ok === false);

red('reject_bypass',
  locks.decideCapability({
    site_key: readSite.site_key,
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    bypass_central_decision: true,
  }, inventory).ok === false);

red('reject_post_acquisition_denial',
  locks.decideCapability({
    site_key: readSite.site_key,
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    acquisition_already_held: true,
  }, inventory).ok === false);

red('reject_mutable_capability_state',
  locks.decideCapability({
    site_key: readSite.site_key,
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    mutable_capability_state: true,
  }, inventory).ok === false);

red('reject_arbitrary_read_id',
  locks.decideCapability({
    site_key: 'not_a_real_site_key',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
  }, inventory).ok === false);

red('reject_missing_tenant',
  locks.decideCapability({
    site_key: readSite.site_key,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
  }, inventory).code === 'missing_tenant_denied');

red('reject_wrong_tenant',
  (() => {
    const wolfOnly = inventory.read_dispatch_adapters.find(
      (a) => a.allowed_tenants.length === 1 && a.allowed_tenants[0] === locks.TENANT_WOLFHOUSE,
    );
    if (!wolfOnly) return false;
    return locks.decideCapability({
      site_key: wolfOnly.site_key,
      tenant: locks.TENANT_SUNSET,
      location: locks.LOCATION_SUNSET,
      turn_id: 't',
    }, inventory).ok === false;
  })());

red('reject_caller_effect_spoofing',
  permit.caller_effect_ignored === 'mutation' && permit.effect === 'read_dispatch');

red('reject_post_decision_mutation',
  (() => {
    const r = locks.decideCapability({
      site_key: readSite.site_key,
      tenant: locks.TENANT_WOLFHOUSE,
      location: locks.LOCATION_WOLFHOUSE,
      turn_id: 't-freeze',
    }, inventory);
    try {
      r.boundary.tenant = 'tampered';
      return false;
    } catch (_) {
      return true;
    }
  })());

red('reject_tenant_confusion',
  locks.decideCapability({
    site_key: readSite.site_key,
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    tenant_confusion: true,
  }, inventory).ok === false);

red('reject_unknown_site',
  locks.decideCapability({
    site_key: 'staff_http_client|nope|_post_bot|/nope',
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
  }, inventory).code === 'unknown_site_denied');

red('reject_trace_deploy_live_overclaim',
  locks.decideCapability({
    site_key: readSite.site_key,
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    claims_trace_implemented: true,
  }, inventory).ok === false);

red('reject_runtime_implemented_claim',
  locks.classifyCapabilityBoundaryFreeze({
    ...design.central_capability_boundary,
    central_decision_point: locks.DECISION_POINT,
    this_slice_implements_runtime: true,
  }).ok === false);

red('reject_dry_run_implementable_today',
  locks.classifyCapabilityBoundaryFreeze({
    ...design.central_capability_boundary,
    central_decision_point: locks.DECISION_POINT,
    dry_run_implementable_today: true,
  }).ok === false);

red('reject_missing_send_category',
  (() => {
    const bad = {
      ...inventory,
      whatsapp_send_adapters: inventory.whatsapp_send_adapters.map((a) => ({ ...a, category: 'direct' })),
    };
    return locks.classifyInventoryDocument(bad, ROOT).ok === false;
  })());

red('reject_missing_location',
  locks.decideCapability({
    site_key: readSite.site_key,
    tenant: locks.TENANT_WOLFHOUSE,
    turn_id: 't',
  }, inventory).code === 'missing_location_denied');

red('reject_tenant_location_mismatch',
  (() => {
    const dual = inventory.read_dispatch_adapters.find(
      (a) => a.allowed_tenants.includes(locks.TENANT_WOLFHOUSE)
        && a.allowed_tenants.includes(locks.TENANT_SUNSET)
        && a.allowed_locations.includes(locks.LOCATION_WOLFHOUSE)
        && a.allowed_locations.includes(locks.LOCATION_SUNSET),
    ) || inventory.whatsapp_send_adapters.find(
      (a) => a.allowed_tenants.includes(locks.TENANT_WOLFHOUSE)
        && a.allowed_locations.includes(locks.LOCATION_SUNSET),
    );
    if (!dual) return false;
    return locks.decideCapability({
      site_key: dual.site_key,
      tenant: locks.TENANT_WOLFHOUSE,
      location: locks.LOCATION_SUNSET,
      turn_id: 't',
    }, inventory).code === 'tenant_location_mismatch';
  })());

red('reject_context_tamper_flag',
  locks.decideCapability({
    site_key: readSite.site_key,
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
    turn_id: 't',
    context_tamper: true,
  }, inventory).ok === false);

red('reject_extra_adapter_set',
  (() => {
    const extra = {
      ...inventory,
      mutation_adapters: [
        ...inventory.mutation_adapters,
        { ...mutSite, site_key: `${mutSite.site_key}|EXTRA` },
      ],
      counts: {
        ...inventory.counts,
        mutation: inventory.counts.mutation + 1,
        total: inventory.counts.total + 1,
      },
    };
    return locks.compareInventoryExactSet(extra, ROOT).ok === false;
  })());

red('reject_bidirectional_missing_expected_id',
  (() => {
    const truncated = {
      ...inventory,
      whatsapp_send_adapters: inventory.whatsapp_send_adapters.slice(1),
      counts: {
        ...inventory.counts,
        whatsapp_send: inventory.counts.whatsapp_send - 1,
        total: inventory.counts.total - 1,
      },
    };
    return locks.compareInventoryExactSet(truncated, ROOT).ok === false;
  })());

red('reject_newly_discovered_unmatched_site',
  (() => {
    const r = locks.enumerateCapabilityIdsFromSource(ROOT, {
      inject_discovered_site_keys: [
        'staff_http_client|docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py|_post_bot|/brand-new-unmatched',
      ],
    });
    return r.ok === false
      && (r.errors || []).some((e) => /newly_discovered_unmatched_site:/.test(e));
  })());

red('reject_acquisition_site_omission',
  (() => {
    const victim = enumerated.whatsapp_send[0];
    const r = locks.enumerateCapabilityIdsFromSource(ROOT, {
      force_omit_site_keys: [victim],
    });
    return r.ok === false
      && (r.errors || []).some((e) => /acquisition_site_omission:/.test(e));
  })());

red('reject_missing_turn',
  locks.decideCapability({
    site_key: readSite.site_key,
    tenant: locks.TENANT_WOLFHOUSE,
    location: locks.LOCATION_WOLFHOUSE,
  }, inventory).code === 'missing_turn_denied');

red('reject_cross_decision_turn_context_drift',
  (() => {
    const first = locks.decideCapability({
      site_key: readSite.site_key,
      tenant: locks.TENANT_WOLFHOUSE,
      location: locks.LOCATION_WOLFHOUSE,
      turn_id: 'turn-stable',
    }, inventory);
    const tenantDrift = locks.decideCapability({
      site_key: sendSite.site_key,
      tenant: locks.TENANT_SUNSET,
      location: locks.LOCATION_SUNSET,
      turn_id: 'turn-stable',
    }, inventory, first.boundary);
    const turnDrift = locks.decideCapability({
      site_key: readSite.site_key,
      tenant: locks.TENANT_WOLFHOUSE,
      location: locks.LOCATION_WOLFHOUSE,
      turn_id: 'turn-other',
    }, inventory, first.boundary);
    const missingPriorContext = locks.bindTurnScope(
      {
        turn_id: 'turn-stable',
        tenant: locks.TENANT_WOLFHOUSE,
        location: locks.LOCATION_WOLFHOUSE,
      },
      { turn_id: 'turn-stable' },
    );
    return tenantDrift.ok === false
      && tenantDrift.code === 'cross_decision_context_drift'
      && turnDrift.ok === false
      && turnDrift.code === 'cross_decision_turn_drift'
      && missingPriorContext.ok === false
      && missingPriorContext.code === 'missing_turn_context';
  })());

red('reject_site_grant_reuse',
  (() => {
    const reg = new Map();
    const d = locks.decideCapability({
      site_key: readSite.site_key,
      tenant: locks.TENANT_WOLFHOUSE,
      location: locks.LOCATION_WOLFHOUSE,
      turn_id: 'grant-turn',
    }, inventory, null, reg);
    const claim = {
      site_key: d.site_key,
      effect: d.effect,
      tenant: d.tenant,
      location: d.location,
      turn_id: d.turn_id,
    };
    const first = locks.consumeSiteGrant(d.site_grant, claim, reg);
    const second = locks.consumeSiteGrant(d.site_grant, claim, reg);
    return first.ok === true && second.ok === false && second.code === 'site_grant_reuse';
  })());

red('reject_site_grant_site_drift',
  (() => {
    const reg = new Map();
    const d = locks.decideCapability({
      site_key: readSite.site_key,
      tenant: locks.TENANT_WOLFHOUSE,
      location: locks.LOCATION_WOLFHOUSE,
      turn_id: 'grant-turn-2',
    }, inventory, null, reg);
    const bad = locks.consumeSiteGrant(d.site_grant, {
      site_key: mutSite.site_key,
      effect: d.effect,
      tenant: d.tenant,
      location: d.location,
      turn_id: d.turn_id,
    }, reg);
    return bad.ok === false && bad.code === 'site_grant_site_drift';
  })());

red('reject_site_grant_effect_drift',
  (() => {
    const reg = new Map();
    const d = locks.decideCapability({
      site_key: readSite.site_key,
      tenant: locks.TENANT_WOLFHOUSE,
      location: locks.LOCATION_WOLFHOUSE,
      turn_id: 'grant-turn-3',
    }, inventory, null, reg);
    const bad = locks.consumeSiteGrant(d.site_grant, {
      site_key: d.site_key,
      effect: 'mutation',
      tenant: d.tenant,
      location: d.location,
      turn_id: d.turn_id,
    }, reg);
    return bad.ok === false && bad.code === 'site_grant_effect_drift';
  })());

red('reject_site_grant_context_drift',
  (() => {
    const reg = new Map();
    const d = locks.decideCapability({
      site_key: readSite.site_key,
      tenant: locks.TENANT_WOLFHOUSE,
      location: locks.LOCATION_WOLFHOUSE,
      turn_id: 'grant-turn-4',
    }, inventory, null, reg);
    const bad = locks.consumeSiteGrant(d.site_grant, {
      site_key: d.site_key,
      effect: d.effect,
      tenant: locks.TENANT_SUNSET,
      location: locks.LOCATION_SUNSET,
      turn_id: d.turn_id,
    }, reg);
    return bad.ok === false && bad.code === 'site_grant_context_drift';
  })());

// Real source-mutation RED fixtures
red('reject_source_mutation_unmatched_post_bot',
  (() => {
    const fixture = readText(`${locks.RED_SOURCE_REL}/unmatched_post_bot.py`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '16ae-red-py-'));
    try {
      // Seed a tiny python graph node with the mutated fixture content
      const rel = 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py';
      const dest = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, fixture);
      // Copy other required python graph nodes from repo so scanner GRAPH_NODES exist
      for (const node of [
        'docker/hermes-staging/apply_gateway_patches.py',
        'docker/hermes-staging/wolfhouse_whatsapp_mirror.py',
        'docker/hermes-staging/wolfhouse_guest_fresh_start.py',
        'docker/hermes-staging/wolfhouse/pause_gate.py',
        'docker/hermes-staging/wolfhouse/explicit_human_handoff.py',
        'docker/hermes-staging/wolfhouse/whatsapp_burst_coalesce.py',
      ]) {
        const abs = path.join(ROOT, node);
        const d = path.join(tmp, node);
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.copyFileSync(abs, d);
      }
      const py = discovery.discoverPythonPhysicalSites(tmp);
      if (!py.ok && (py.unresolved_dynamics || []).length) {
        // still ok for this RED if sites include evil path
      }
      const evil = (py.sites || []).some((s) => String(s.fingerprint).includes('evil-unregistered-mutate'));
      if (!evil) return false;
      const recon = discovery.reconcileDiscoveryWithPolicy(
        {
          ok: true,
          site_keys: (py.sites || []).map((s) => s.site_key),
          errors: [],
          scanner_counts: {},
        },
        policyLoad.policy,
      );
      return recon.ok === false
        && (recon.errors || []).some((e) => /unmatched_discovered_site:/.test(e) && /evil-unregistered-mutate/.test(e));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })());

red('reject_source_mutation_dynamic_post_bot',
  (() => {
    const fixture = readText(`${locks.RED_SOURCE_REL}/dynamic_post_bot.py`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '16ae-red-dyn-'));
    try {
      const rel = 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py';
      const dest = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, fixture);
      for (const node of [
        'docker/hermes-staging/apply_gateway_patches.py',
        'docker/hermes-staging/wolfhouse_whatsapp_mirror.py',
        'docker/hermes-staging/wolfhouse_guest_fresh_start.py',
        'docker/hermes-staging/wolfhouse/pause_gate.py',
        'docker/hermes-staging/wolfhouse/explicit_human_handoff.py',
        'docker/hermes-staging/wolfhouse/whatsapp_burst_coalesce.py',
      ]) {
        const abs = path.join(ROOT, node);
        const d = path.join(tmp, node);
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.copyFileSync(abs, d);
      }
      const py = discovery.discoverPythonPhysicalSites(tmp);
      return py.ok === false
        && (py.unresolved_dynamics || []).some((e) => /unresolved_dynamic_call:/.test(e));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })());

red('reject_source_mutation_extra_stripe_site',
  (() => {
    const fixture = readText(`${locks.RED_SOURCE_REL}/extra_stripe_site.js`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '16ae-red-js-'));
    try {
      for (const node of discovery.JS_GRAPH_NODES) {
        const abs = path.join(ROOT, node);
        const d = path.join(tmp, node);
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.copyFileSync(abs, d);
      }
      fs.writeFileSync(
        path.join(tmp, 'scripts/lib/luna-whatsapp-provider.js'),
        fixture,
      );
      const js = discovery.discoverJsPhysicalSites(tmp);
      const extraKey = 'stripe_sdk|scripts/lib/luna-whatsapp-provider.js|checkout.sessions.create|create';
      if (!(js.sites || []).some((s) => s.site_key === extraKey)) return false;
      // Merge mutated JS sites with real Python discovery so only the extra site is unmatched.
      const real = discovery.discoverPhysicalSites(ROOT);
      const mergedKeys = sortedUnique([
        ...real.site_keys.filter((k) => !k.includes('luna-whatsapp-provider.js')),
        ...js.sites.map((s) => s.site_key),
      ]);
      const recon = discovery.reconcileDiscoveryWithPolicy(
        {
          ok: true,
          site_keys: mergedKeys,
          errors: [],
          scanner_counts: {},
        },
        policyLoad.policy,
      );
      return recon.ok === false
        && (recon.errors || []).some((e) => e === `unmatched_discovered_site:${extraKey}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })());

function sortedUnique(arr) {
  return [...new Set(arr)].sort();
}

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
  && matrix.slice_16ae_selection.inventory_counts.whatsapp_send === FROZEN_COUNTS.whatsapp_send
  && matrix.slice_16ae_selection.inventory_counts.mutation === FROZEN_COUNTS.mutation
  && matrix.slice_16ae_selection.inventory_counts.read_dispatch === FROZEN_COUNTS.read_dispatch
  && matrix.slice_16ae_selection.inventory_counts.total === FROZEN_COUNTS.total);

green('ops_contract_16ae',
  opsContract.slice === locks.SLICE
  && opsContract.selected_16ae
  && opsContract.selected_16ae.outcome_id === locks.OUTCOME_ID
  && opsContract.selected_16ae.inventory_counts
  && opsContract.selected_16ae.inventory_counts.total === FROZEN_COUNTS.total
  && opsContract.selected_16u
  && opsContract.selected_16u.outcome_id === '16U_correlation_design_freeze'
  && opsContract.capability_boundary_design === 'frozen_via_16AE'
  && opsContract.selected_16ad
  && opsContract.selected_16ad.g02_verdict === 'partial');

green('ledger_mentions_16ae',
  /16AE_g01_capability_boundary_freeze|16AE/.test(ledger)
  && /decideCapability|capability boundary/i.test(ledger)
  && /PHYSICAL_SITE_AST_DISCOVERY|ast_discovered_site_policy|site grant|Acorn|Python ast/i.test(ledger)
  && new RegExp(String(FROZEN_COUNTS.whatsapp_send)).test(ledger)
  && new RegExp(String(FROZEN_COUNTS.mutation)).test(ledger)
  && new RegExp(String(FROZEN_COUNTS.read_dispatch)).test(ledger)
  && /16U/.test(ledger)
  && /16AD/.test(ledger)
  && /partial/i.test(ledger)
  && /not implement|runtime apply|not wired|not activatable/i.test(ledger));

green('findings_mentions_16ae',
  /16AE/.test(findings)
  && /capability boundary/i.test(findings)
  && /decideCapability|AST|site grant|physical.site/i.test(findings)
  && /16U/.test(findings)
  && /16AD/.test(findings)
  && /proven=0/.test(findings));

green('branch_pin', currentBranch() === locks.BRANCH, currentBranch());

const rt = runtimePathsUnchanged();
green('runtime_paths_unchanged', rt.ok, rt.detail);

const ownedBlob = locks.OWNED_RELS.map((rel) => {
  try {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      return fs.readdirSync(abs).map((f) => fs.readFileSync(path.join(abs, f), 'utf8')).join('\n');
    }
    return readText(rel);
  } catch (_) {
    return '';
  }
}).join('\n');
const sec = secretFree(ownedBlob, 'owned');
green('secret_free', sec.ok, sec.detail);

const pkg = readJson('package.json');
green('package_script',
  pkg.scripts
  && pkg.scripts['verify:radar-slice16ae-g01-capability-boundary-freeze']
    === 'node scripts/verify-radar-slice16ae-g01-capability-boundary-freeze.js'
  && pkg.devDependencies
  && pkg.devDependencies.acorn);

const requiredRed = [
  'reject_omission',
  'reject_self_reported_complete_flag',
  'reject_demonstrated_omission',
  'reject_demonstrated_extra_booking_dry_run',
  'reject_collapsed_duplicate_present',
  'reject_duplicate_site_keys',
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
  'reject_unknown_site',
  'reject_trace_deploy_live_overclaim',
  'reject_runtime_implemented_claim',
  'reject_dry_run_implementable_today',
  'reject_missing_send_category',
  'reject_missing_location',
  'reject_tenant_location_mismatch',
  'reject_context_tamper_flag',
  'reject_extra_adapter_set',
  'reject_bidirectional_missing_expected_id',
  'reject_newly_discovered_unmatched_site',
  'reject_acquisition_site_omission',
  'reject_missing_turn',
  'reject_cross_decision_turn_context_drift',
  'reject_site_grant_reuse',
  'reject_site_grant_site_drift',
  'reject_site_grant_effect_drift',
  'reject_site_grant_context_drift',
  'reject_source_mutation_unmatched_post_bot',
  'reject_source_mutation_dynamic_post_bot',
  'reject_source_mutation_extra_stripe_site',
];
const requiredGreen = [
  'fixtures_present',
  'pins',
  'identity_rule_frozen',
  'contract_pins',
  'inventory_pins',
  'frozen_specification_loaded',
  'site_policy_loaded',
  'inventory_classifier_accepts',
  'source_derived_exact_set',
  'source_enumeration_independent',
  'bidirectional_exact_set',
  'scanner_counts_present',
  'source_derivation_ok',
  'no_predefined_acquisition_classifiers',
  'central_decision_point_frozen',
  'design_freeze_classifier_accepts',
  'decide_permits_read',
  'decide_multi_site_same_turn',
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

console.log(`\nScanner counts: ${JSON.stringify(enumerated.scanner_counts)}`);
console.log(`Inventory counts: ${JSON.stringify(FROZEN_COUNTS)}`);
console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('RADAR 16AE capability boundary freeze: PASS');
