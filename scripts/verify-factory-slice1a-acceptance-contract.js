'use strict';

/**
 * verify:factory-slice1a-acceptance-contract — FACTORY Slice 1A
 *
 * Source-only acceptance contract freeze. No network, no DB, no secrets,
 * no deploy, no generator/templates/runtime/IaC mutation in this slice.
 *
 * Completeness: derives registration/read-site inventory from real paths via
 * factory-slice1a-inventory-discovery.js and requires exact bidirectional
 * coverage against the fixture (rejects incomplete and stale candidate lists).
 * Locked exclusions filter justified noise only — never the expected inventory.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'factory-client-productization');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice1a-contract.json');
const INVENTORY_PATH = path.join(FIXTURE_DIR, 'slice1a-inventory.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice1a-findings.md');
const DOC_PATH = path.join(ROOT, 'docs', 'FACTORY-CLIENT-PRODUCTIZATION.md');

const locks = require('./lib/factory-slice1a-acceptance-contract');
const {
  discoverAll,
  compareInventoryCompleteness,
  buildAdversarialTemporarySource,
  INVENTORY_CATEGORIES,
} = require('./lib/factory-slice1a-inventory-discovery');

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
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function red(id, cond, detail) {
  const passed = ok(`RED ${id}`, cond, detail);
  redResults.push({ id, ok: passed });
  return passed;
}

function green(id, cond, detail) {
  const passed = ok(`GREEN ${id}`, cond, detail);
  greenResults.push({ id, ok: passed });
  return passed;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

function deepEqual(a, b) {
  return locks.deepEqual(a, b);
}

function rimraf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function tipPathsAllowed(changedPaths) {
  const prefixes = locks.ALLOWED_TIP_PATH_PREFIXES;
  const bad = [];
  for (const p of changedPaths) {
    const okPath = prefixes.some((pref) => (
      pref.endsWith('/') ? p.startsWith(pref) || p === pref.slice(0, -1) : p === pref
    ));
    if (!okPath) bad.push(p);
  }
  return { ok: bad.length === 0, bad };
}

function packageJsonScriptDeltaOnlyAllowedKey() {
  let diff;
  try {
    diff = execSync(
      `git diff ${locks.MASTER_BASIS} -- package.json`,
      { cwd: ROOT, encoding: 'utf8' },
    );
  } catch (err) {
    return { ok: false, detail: String(err && err.message) };
  }
  if (!diff.trim()) {
    // Tip may already include the key on master; still require the locked key present.
    const pkg = readJson(path.join(ROOT, 'package.json'));
    const val = pkg.scripts && pkg.scripts[locks.PACKAGE_JSON_ALLOWED_SCRIPT_KEY];
    return {
      ok: val === locks.PACKAGE_JSON_ALLOWED_SCRIPT_VALUE,
      detail: val === locks.PACKAGE_JSON_ALLOWED_SCRIPT_VALUE
        ? 'no package.json delta vs master; locked key present'
        : 'locked script key missing/mismatched with no delta',
    };
  }
  const addedKeys = [];
  const removedKeys = [];
  const otherHunkNoise = [];
  for (const line of diff.split('\n')) {
    if (!/^[+-]/.test(line) || /^[+-]{3}/.test(line)) continue;
    if (/^[+-]\s*"verify:[^"]+"\s*:/.test(line)) {
      const m = line.match(/^[+-]\s*"([^"]+)"\s*:/);
      if (m) {
        if (line.startsWith('+')) addedKeys.push(m[1]);
        else removedKeys.push(m[1]);
      }
      continue;
    }
    // Allow JSON structural whitespace / commas adjacent to the script line.
    if (/^[+-]\s*[\[\]{},]?\s*$/.test(line)) continue;
    if (/^[+-]\s*$/.test(line)) continue;
    otherHunkNoise.push(line.slice(0, 120));
  }
  const onlyAllowedAdd = addedKeys.length === 1
    && addedKeys[0] === locks.PACKAGE_JSON_ALLOWED_SCRIPT_KEY
    && removedKeys.length === 0;
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const val = pkg.scripts && pkg.scripts[locks.PACKAGE_JSON_ALLOWED_SCRIPT_KEY];
  const valueOk = val === locks.PACKAGE_JSON_ALLOWED_SCRIPT_VALUE;
  return {
    ok: onlyAllowedAdd && valueOk && otherHunkNoise.length === 0,
    detail: JSON.stringify({
      addedKeys,
      removedKeys,
      valueOk,
      otherHunkNoise: otherHunkNoise.slice(0, 5),
    }),
  };
}

console.log('verify:factory-slice1a-acceptance-contract — FACTORY 1A\n');

// ── Artifacts present ───────────────────────────────────────────────────────
console.log('── Artifacts ──');
ok('contract fixture exists', fs.existsSync(CONTRACT_PATH));
ok('inventory fixture exists', fs.existsSync(INVENTORY_PATH));
ok('findings exist', fs.existsSync(FINDINGS_PATH));
ok('doc exists', fs.existsSync(DOC_PATH));

const contract = readJson(CONTRACT_PATH);
const inventory = readJson(INVENTORY_PATH);
const findings = readText(FINDINGS_PATH);
const doc = readText(DOC_PATH);
const expected = locks.thaw(locks.CONTRACT);

// ── Canonical lock vs fixture ───────────────────────────────────────────────
console.log('\n── Canonical contract locks ──');
const validation = locks.validateFactory1aContract({
  slice: contract.slice,
  outcome_id: contract.outcome_id,
  master_basis: contract.master_basis,
  live_mutation: contract.live_mutation,
  runtime_behavior_changed: contract.runtime_behavior_changed,
  completeness_method: contract.completeness_method,
  finite_stages: contract.finite_stages,
  archetypes: contract.archetypes,
  gates: contract.gates,
  evidence_classes: contract.evidence_classes,
  scope_fence: contract.scope_fence,
  tip_scope: contract.tip_scope,
  existing_regression_gates: contract.existing_regression_gates,
  existing_regression_retained_master_red: contract.existing_regression_retained_master_red,
});
ok('validateFactory1aContract(fixture) ok', validation.ok, validation.errors.join(','));
ok('slice id FACTORY-1A', contract.slice === locks.SLICE);
ok('outcome id locked', contract.outcome_id === locks.OUTCOME_ID);
ok('master basis 0ef5958e…', contract.master_basis === locks.MASTER_BASIS);
ok('branch locked', contract.branch === locks.BRANCH);
ok('completeness method locked', contract.completeness_method === locks.COMPLETENESS_METHOD);
ok('live_mutation false', contract.live_mutation === false);
ok('runtime_behavior_changed false', contract.runtime_behavior_changed === false);
ok('finite stages deep-equal locks', deepEqual(contract.finite_stages, expected.finite_stages));
ok('archetypes deep-equal locks', deepEqual(contract.archetypes, expected.archetypes));
ok('gates deep-equal locks', deepEqual(contract.gates, expected.gates));
ok('evidence_classes deep-equal locks', deepEqual(contract.evidence_classes, expected.evidence_classes));
ok('scope_fence deep-equal locks', deepEqual(contract.scope_fence, expected.scope_fence));
ok('tip_scope deep-equal locks', deepEqual(contract.tip_scope, expected.tip_scope));
ok('existing regression gates deep-equal locks',
  deepEqual(contract.existing_regression_gates, expected.existing_regression_gates));
ok('retained master RED deep-equal locks',
  deepEqual(contract.existing_regression_retained_master_red, expected.existing_regression_retained_master_red));

const stageIds = contract.finite_stages.map((s) => s.id);
ok('exactly five stages 1A–1E', deepEqual(stageIds, ['1A', '1B', '1C', '1D', '1E']));
ok('only 1A in_scope_current', contract.finite_stages.filter((s) => s.status === 'in_scope_current').length === 1
  && contract.finite_stages[0].id === '1A');
ok('1A forbids productization surfaces', deepEqual(contract.finite_stages[0].forbids, expected.finite_stages[0].forbids));

const gateIds = contract.gates.map((g) => g.id);
ok('nine gates present', gateIds.length === 9);
ok('archetype gates present', gateIds.includes('G_ARCHETYPE_SURF_HOUSE')
  && gateIds.includes('G_ARCHETYPE_SURF_SCHOOL_SHOP'));
ok('generation/safety gates present', [
  'G_DISABLED_BY_DEFAULT_GENERATION',
  'G_SECRET_REJECTION',
  'G_NO_LIVE_TARGET_COPYING',
  'G_TENANT_LOCATION_ISOLATION',
  'G_LEGACY_COMPATIBILITY',
  'G_DRY_RUN_PROOF',
  'G_MILESTONE_CLOSEOUT',
].every((id) => gateIds.includes(id)));

ok('third_tenant out of scope + RADAR reopen',
  contract.evidence_classes.third_tenant_live_prod.status === 'out_of_scope'
  && contract.evidence_classes.third_tenant_live_prod.effect === 'triggers_RADAR_reopen'
  && contract.evidence_classes.third_tenant_live_prod.reopen_trigger_id === 'third_tenant_factory');

// ── Docs / findings language ────────────────────────────────────────────────
console.log('\n── Docs and findings ──');
ok('doc names FACTORY and 1A–1E', /FACTORY/i.test(doc) && /1A/.test(doc) && /1E/.test(doc));
ok('doc names both archetypes', /surf_house/.test(doc) && /surf_school_shop/.test(doc));
ok('doc separates third-tenant live/prod', /third.tenant/i.test(doc) && /third_tenant_factory/.test(doc));
ok('doc forbids templates/generator/runtime in 1A', /forbids/i.test(doc) && /templates/i.test(doc) && /generator/i.test(doc));
ok('doc states package.json single-script scope', /package\.json/i.test(doc) && /verify:factory-slice1a-acceptance-contract/.test(doc));
ok('findings cite completeness method', /source_derived_registration_read_site_inventory/.test(findings));
ok('findings cite master basis', findings.includes(locks.MASTER_BASIS));
ok('findings list nine gates', /G_MILESTONE_CLOSEOUT/.test(findings) && /G_SECRET_REJECTION/.test(findings));
ok('findings mention staff-query-api and check-i18n',
  /staff-query-api/.test(findings) && /check-i18n/.test(findings));
ok('no trailing whitespace in doc/findings', (() => {
  for (const [label, text] of [['doc', doc], ['findings', findings]]) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (/[ \t]+$/.test(lines[i])) {
        console.log(`    trailing ws in ${label} line ${i + 1}`);
        return false;
      }
    }
  }
  return true;
})());

// ── Source-derived inventory completeness ───────────────────────────────────
console.log('\n── Source-derived inventory completeness ──');
const discovered = discoverAll();
ok('discovery completeness method', discovered.completeness_method === locks.COMPLETENESS_METHOD);
ok('inventory fixture method matches', inventory.completeness_method === locks.COMPLETENESS_METHOD);
ok('inventory categories match lock list', deepEqual(inventory.categories, INVENTORY_CATEGORIES.slice()));
ok('locked exclusions are not the expected inventory',
  Array.isArray(discovered.locked_exclusions.path_substrings)
  && !deepEqual(discovered.locked_exclusions.path_substrings, discovered.pricing_services_schedule_profile_consumers)
  && discovered.locked_exclusions.verifier_path_prefixes.every((p) => !discovered.existing_verifiers.some((v) => v.startsWith(p))));

const completeness = compareInventoryCompleteness(inventory, discovered);
ok('inventory bidirectional completeness', completeness.ok, completeness.errors.join(','));
if (!completeness.ok) {
  for (const cat of INVENTORY_CATEGORIES) {
    const d = completeness.details[cat];
    if (d.missing_in_fixture.length) {
      console.log(`    missing_in_fixture[${cat}]:`, d.missing_in_fixture.slice(0, 20));
    }
    if (d.stale_in_fixture.length) {
      console.log(`    stale_in_fixture[${cat}]:`, d.stale_in_fixture.slice(0, 20));
    }
  }
}

ok('reference pair wolfhouse present', discovered.reference_pair.wolfhouse
  && discovered.reference_pair.wolfhouse.client_slug === 'wolfhouse'
  && discovered.reference_pair.wolfhouse.live_enabled === false
  && discovered.reference_pair.wolfhouse.vertical === 'lodging_surf_house');
ok('reference pair sunset present', discovered.reference_pair.sunset
  && discovered.reference_pair.sunset.client_slug === 'sunset'
  && discovered.reference_pair.sunset.live_enabled === false
  && discovered.reference_pair.sunset.vertical === 'surf_school_rentals'
  && discovered.reference_pair.sunset.location_ids.includes('sunset-sardinero'));
ok('inventory reference_pair matches discovery', deepEqual(inventory.reference_pair, discovered.reference_pair));

ok('clients.json among registries', discovered.registries.includes('config/clients/clients.json'));
ok('wolfhouse + sunset baselines inventoried',
  discovered.client_config_files.includes('config/clients/wolfhouse-somo.baseline.json')
  && discovered.client_config_files.includes('config/clients/sunset.baseline.json'));
ok('staff-query-api and check-i18n among consumers',
  discovered.pricing_services_schedule_profile_consumers.includes('scripts/staff-query-api.js')
  && discovered.pricing_services_schedule_profile_consumers.includes('scripts/check-i18n-guest-copy.js'));
ok('primary loaders include portal + tenant-business + channel resolver',
  discovered.pricing_services_schedule_profile_consumers.includes('scripts/lib/staff-portal-clients.js')
  && discovered.pricing_services_schedule_profile_consumers.includes('scripts/lib/tenant-business-config.js')
  && discovered.pricing_services_schedule_profile_consumers.includes('scripts/lib/client-channel-resolver.js'));
ok('deployment overlays include both staging bicep',
  discovered.deployment_overlays.includes('infra/azure/staging/main.bicep')
  && discovered.deployment_overlays.includes('infra/azure/sunset-staging/main.bicep'));
ok('existing multiclient verifier present',
  discovered.existing_verifiers.includes('scripts/verify-multiclient-isolation.js'));

// ── RED / GREEN adversarial ─────────────────────────────────────────────────
console.log('\n── Adversarial RED/GREEN ──');

red('R1_stage_drift_1F', (() => {
  const bad = locks.thaw(locks.CONTRACT);
  bad.finite_stages.push({ id: '1F', title: 'drift', status: 'deferred_future_stage' });
  return locks.validateFactory1aContract(bad).ok === false
    && locks.validateFactory1aContract(bad).errors.includes('stage_drift_rejected');
})());

red('R2_gate_rename', (() => {
  const bad = locks.thaw(locks.CONTRACT);
  bad.gates[0].id = 'G_ARCHETYPE_SURF_HOUSE_RENAMED';
  return locks.validateFactory1aContract(bad).ok === false;
})());

red('R3_third_tenant_as_current_evidence', (() => {
  const bad = locks.thaw(locks.CONTRACT);
  bad.evidence_classes.third_tenant_live_prod.status = 'required_current_stage';
  bad.evidence_classes.third_tenant_live_prod.effect = 'in_scope';
  return locks.validateFactory1aContract(bad).ok === false;
})());

red('R4_stale_inventory_entry', (() => {
  const stale = JSON.parse(JSON.stringify(inventory));
  stale.client_config_files = stale.client_config_files.concat(['config/clients/DOES_NOT_EXIST.baseline.json']);
  return compareInventoryCompleteness(stale, discovered).ok === false;
})());

red('R5_incomplete_inventory_omits_clients_json', (() => {
  const incomplete = JSON.parse(JSON.stringify(inventory));
  incomplete.registries = incomplete.registries.filter((p) => p !== 'config/clients/clients.json');
  return compareInventoryCompleteness(incomplete, discovered).ok === false;
})());

red('R6_live_mutation_claim', (() => {
  const bad = locks.thaw(locks.CONTRACT);
  bad.live_mutation = true;
  return locks.validateFactory1aContract(bad).ok === false;
})());

// Temporary-source REDs: aliased/wrapped/dynamic consumers + new registry/overlay/verifier/flag sites.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1a-adv-'));
  let advDiscovered = null;
  let expectedNew = null;
  try {
    const built = buildAdversarialTemporarySource(tmp);
    expectedNew = built.expected_new;
    advDiscovered = discoverAll({ root: built.root });

    red('R7_temp_source_aliased_wrapped_dynamic_consumer', (() => {
      const hasAlias = advDiscovered.pricing_services_schedule_profile_consumers.includes(
        'scripts/lib/adversarial-client-wrapper.js',
      );
      const hasStaffApi = advDiscovered.pricing_services_schedule_profile_consumers.includes(
        'scripts/staff-query-api.js',
      );
      const hasI18n = advDiscovered.pricing_services_schedule_profile_consumers.includes(
        'scripts/check-i18n-guest-copy.js',
      );
      const incomplete = JSON.parse(JSON.stringify({
        client_config_files: advDiscovered.client_config_files,
        registries: advDiscovered.registries,
        feature_flag_symbols: advDiscovered.feature_flag_symbols,
        pricing_services_schedule_profile_consumers:
          advDiscovered.pricing_services_schedule_profile_consumers.filter(
            (p) => p !== 'scripts/lib/adversarial-client-wrapper.js'
              && p !== 'scripts/staff-query-api.js'
              && p !== 'scripts/check-i18n-guest-copy.js',
          ),
        deployment_overlays: advDiscovered.deployment_overlays,
        existing_verifiers: advDiscovered.existing_verifiers,
      }));
      const cmp = compareInventoryCompleteness(incomplete, advDiscovered);
      return hasAlias && hasStaffApi && hasI18n && cmp.ok === false
        && cmp.details.pricing_services_schedule_profile_consumers.missing_in_fixture.length >= 3;
    })());

    red('R8_temp_source_new_registry_absent_from_fixture', (() => {
      const present = expectedNew.registries.every((p) => advDiscovered.registries.includes(p));
      const incomplete = JSON.parse(JSON.stringify({
        client_config_files: advDiscovered.client_config_files,
        registries: advDiscovered.registries.filter((p) => !expectedNew.registries.includes(p)),
        feature_flag_symbols: advDiscovered.feature_flag_symbols,
        pricing_services_schedule_profile_consumers: advDiscovered.pricing_services_schedule_profile_consumers,
        deployment_overlays: advDiscovered.deployment_overlays,
        existing_verifiers: advDiscovered.existing_verifiers,
      }));
      const cmp = compareInventoryCompleteness(incomplete, advDiscovered);
      return present && cmp.ok === false
        && expectedNew.registries.every((p) => cmp.details.registries.missing_in_fixture.includes(p));
    })());

    red('R9_temp_source_new_overlay_absent_from_fixture', (() => {
      const overlay = 'infra/azure/adversarial-staging/main.bicep';
      const present = advDiscovered.deployment_overlays.includes(overlay);
      const incomplete = JSON.parse(JSON.stringify({
        client_config_files: advDiscovered.client_config_files,
        registries: advDiscovered.registries,
        feature_flag_symbols: advDiscovered.feature_flag_symbols,
        pricing_services_schedule_profile_consumers: advDiscovered.pricing_services_schedule_profile_consumers,
        deployment_overlays: advDiscovered.deployment_overlays.filter((p) => p !== overlay),
        existing_verifiers: advDiscovered.existing_verifiers,
      }));
      const cmp = compareInventoryCompleteness(incomplete, advDiscovered);
      return present && cmp.ok === false
        && cmp.details.deployment_overlays.missing_in_fixture.includes(overlay);
    })());

    red('R10_temp_source_new_verifier_registration_absent_from_fixture', (() => {
      const v = 'scripts/verify-adversarial-factory-client.js';
      const present = advDiscovered.existing_verifiers.includes(v);
      const incomplete = JSON.parse(JSON.stringify({
        client_config_files: advDiscovered.client_config_files,
        registries: advDiscovered.registries,
        feature_flag_symbols: advDiscovered.feature_flag_symbols,
        pricing_services_schedule_profile_consumers: advDiscovered.pricing_services_schedule_profile_consumers,
        deployment_overlays: advDiscovered.deployment_overlays,
        existing_verifiers: advDiscovered.existing_verifiers.filter((p) => p !== v),
      }));
      const cmp = compareInventoryCompleteness(incomplete, advDiscovered);
      return present && cmp.ok === false
        && cmp.details.existing_verifiers.missing_in_fixture.includes(v);
    })());

    red('R11_temp_source_new_flag_site_absent_from_fixture', (() => {
      const flag = 'STAFF_API_ADMISSION_CONTROL';
      const present = advDiscovered.feature_flag_symbols.includes(flag);
      const incomplete = JSON.parse(JSON.stringify({
        client_config_files: advDiscovered.client_config_files,
        registries: advDiscovered.registries,
        feature_flag_symbols: advDiscovered.feature_flag_symbols.filter((s) => s !== flag),
        pricing_services_schedule_profile_consumers: advDiscovered.pricing_services_schedule_profile_consumers,
        deployment_overlays: advDiscovered.deployment_overlays,
        existing_verifiers: advDiscovered.existing_verifiers,
      }));
      const cmp = compareInventoryCompleteness(incomplete, advDiscovered);
      return present && cmp.ok === false
        && cmp.details.feature_flag_symbols.missing_in_fixture.includes(flag);
    })());
  } finally {
    rimraf(tmp);
  }
}

green('G1_canonical_contract_validates', locks.validateFactory1aContract(expected).ok === true);

green('G2_fresh_discovery_matches_fixture', compareInventoryCompleteness(inventory, discoverAll()).ok === true);

green('G3_surf_house_maps_wolfhouse', contract.archetypes[0].id === 'surf_house'
  && contract.archetypes[0].reference_client_slug === 'wolfhouse'
  && contract.archetypes[0].legacy_vertical === 'lodging_surf_house');

green('G4_surf_school_shop_maps_sunset', contract.archetypes[1].id === 'surf_school_shop'
  && contract.archetypes[1].reference_client_slug === 'sunset'
  && contract.archetypes[1].legacy_vertical === 'surf_school_rentals');

green('G5_1A_forbids_generator_templates_runtime', expected.finite_stages[0].forbids.includes('generator')
  && expected.finite_stages[0].forbids.includes('templates')
  && expected.finite_stages[0].forbids.includes('runtime')
  && expected.finite_stages[0].forbids.includes('live_calls'));

// ── Slice tip scope (truthful package.json + no productization surfaces) ────
console.log('\n── Slice tip scope (docs/fixtures/verifier + locked package.json script) ──');
const forbiddenNewPaths = [
  'scripts/lib/factory-client-generator.js',
  'scripts/generate-client-config.js',
  'config/clients/_archetype-surf_house.template.json',
  'config/clients/_archetype-surf_school_shop.template.json',
];
ok('no generator/template productization files added',
  forbiddenNewPaths.every((p) => !fs.existsSync(path.join(ROOT, p))));

{
  let changed = [];
  try {
    changed = execSync(`git diff --name-only ${locks.MASTER_BASIS}`, {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);
  } catch (err) {
    changed = [`__git_diff_failed__:${err && err.message}`];
  }
  const scope = tipPathsAllowed(changed);
  ok('tip paths within locked prefixes', scope.ok, scope.bad.slice(0, 12).join(','));

  const pkgDelta = packageJsonScriptDeltaOnlyAllowedKey();
  ok('package.json delta is only locked verifier script registration', pkgDelta.ok, pkgDelta.detail);
}

// ── Existing regressions ────────────────────────────────────────────────────
console.log('\n── Existing multiclient/config regressions (hard) ──');
function runNodeScript(relScript) {
  const r = spawnSync(process.execPath, [path.join(ROOT, relScript)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    timeout: 120000,
  });
  return r;
}

const hardScripts = [
  'scripts/verify-multiclient-isolation.js',
  'scripts/verify-no-client-hardcoding.js',
  'scripts/verify-tenant-resolution.js',
  'scripts/verify-meta-whatsapp-tenant-shadow.js',
];
for (const rel of hardScripts) {
  const r = runNodeScript(rel);
  ok(`${rel} exit 0`, r.status === 0, r.status !== 0 ? (r.stderr || r.stdout || '').slice(-400) : '');
}

console.log('\n── Retained master RED regressions (reported, not fail-closed by 1A) ──');
const retained = locks.EXISTING_REGRESSION_RETAINED_MASTER_RED;
for (const row of retained) {
  const rel = row.gate.replace(/^node\s+/, '');
  const r = runNodeScript(rel);
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const stillRed = r.status !== 0;
  ok(`${rel} still RED on master tip (retained)`, stillRed,
    stillRed ? '' : 'unexpectedly green — update retained_master_red lock');
  if (row.retained_failure) {
    ok(`${rel} retains expected failure marker`, stillRed && out.includes(row.retained_failure.split('(')[0].trim()),
      `expected to mention: ${row.retained_failure}`);
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n── factory-slice1a: ${pass} passed, ${fail} failed ──`);
console.log(`  RED ${redResults.filter((r) => r.ok).length}/${redResults.length}  GREEN ${greenResults.filter((g) => g.ok).length}/${greenResults.length}`);

if (fail > 0) process.exit(1);
console.log('FACTORY Slice 1A acceptance contract: PASS');
process.exit(0);
