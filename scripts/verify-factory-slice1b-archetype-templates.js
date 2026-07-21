'use strict';

/**
 * verify:factory-slice1b-archetype-templates — FACTORY Slice 1B
 *
 * Independent static verifier for reviewed archetype templates under
 * config/archetypes/. Exact schemas, cross-file refs, tenant/location
 * isolation, and adversarial secret/live-target/missing-field/default-enable
 * REDs. No network, no DB, no generator, no runtime loading, no deploy.
 *
 * Reference-byte checks use working-tree hash-object vs pinned master blobs
 * (never HEAD:path). Archetype file sets are enumerated from disk.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'factory-client-productization');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice1b-contract.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice1b-findings.md');
const DOC_PATH = path.join(ROOT, 'docs', 'FACTORY-CLIENT-PRODUCTIZATION.md');
const locks = require('./lib/factory-slice1b-archetype-templates');

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

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
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

function loadArchetypeBundle(archetypeId) {
  const dir = path.join(ROOT, locks.ARCHETYPE_ROOT, archetypeId);
  const files = {
    manifest: readJson(path.join(dir, 'archetype.manifest.json')),
    baseline: readJson(path.join(dir, 'baseline.template.json')),
    secretsExample: readJson(path.join(dir, 'secrets.example.template.json')),
    compatibility: readJson(path.join(dir, 'compatibility.json')),
    pricing: null,
  };
  const pricingPath = path.join(dir, 'pricing.template.json');
  if (fs.existsSync(pricingPath)) files.pricing = readJson(pricingPath);
  return files;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function writeTempBundle(bundleMap) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1b-adv-'));
  for (const archetypeId of Object.keys(bundleMap)) {
    const dir = path.join(tmp, 'config', 'archetypes', archetypeId);
    fs.mkdirSync(dir, { recursive: true });
    const b = bundleMap[archetypeId];
    fs.writeFileSync(path.join(dir, 'archetype.manifest.json'), JSON.stringify(b.manifest, null, 2));
    fs.writeFileSync(path.join(dir, 'baseline.template.json'), JSON.stringify(b.baseline, null, 2));
    fs.writeFileSync(path.join(dir, 'secrets.example.template.json'), JSON.stringify(b.secretsExample, null, 2));
    fs.writeFileSync(path.join(dir, 'compatibility.json'), JSON.stringify(b.compatibility, null, 2));
    if (b.pricing) {
      fs.writeFileSync(path.join(dir, 'pricing.template.json'), JSON.stringify(b.pricing, null, 2));
    }
  }
  return tmp;
}

function validateBundleFromDisk(root, archetypeId) {
  const dir = path.join(root, locks.ARCHETYPE_ROOT, archetypeId);
  const bundle = {
    archetypeId,
    manifest: readJson(path.join(dir, 'archetype.manifest.json')),
    baseline: readJson(path.join(dir, 'baseline.template.json')),
    secretsExample: readJson(path.join(dir, 'secrets.example.template.json')),
    compatibility: readJson(path.join(dir, 'compatibility.json')),
    pricing: fs.existsSync(path.join(dir, 'pricing.template.json'))
      ? readJson(path.join(dir, 'pricing.template.json'))
      : null,
  };
  const errors = [];
  errors.push(...locks.validateManifest(bundle.manifest, archetypeId));
  errors.push(...locks.validateCompatibility(bundle.compatibility, archetypeId));
  errors.push(...locks.validateBaselineTemplate(bundle.baseline, archetypeId));
  if (archetypeId === 'surf_house') {
    errors.push(...locks.validatePricingTemplate(bundle.pricing));
  }
  errors.push(...locks.validateCrossFileReferences(bundle));
  const textBlob = [
    JSON.stringify(bundle.manifest),
    JSON.stringify(bundle.baseline),
    JSON.stringify(bundle.secretsExample),
    JSON.stringify(bundle.compatibility),
    bundle.pricing ? JSON.stringify(bundle.pricing) : '',
  ].join('\n');
  const forbidden = locks.scanForbiddenContent(textBlob);
  for (const id of forbidden) errors.push(`forbidden_content:${id}`);
  return { errors, bundle };
}

console.log('verify:factory-slice1b-archetype-templates — FACTORY 1B\n');

// ── Artifacts ───────────────────────────────────────────────────────────────
console.log('── Artifacts ──');
ok('contract fixture exists', fs.existsSync(CONTRACT_PATH));
ok('findings exist', fs.existsSync(FINDINGS_PATH));
ok('doc exists', fs.existsSync(DOC_PATH));
ok('exactly two archetype dirs', locks.ARCHETYPE_IDS.length === 2
  && fs.existsSync(path.join(ROOT, 'config/archetypes/surf_house'))
  && fs.existsSync(path.join(ROOT, 'config/archetypes/surf_school_shop')));

for (const id of locks.ARCHETYPE_IDS) {
  for (const rel of locks.ARCHETYPE_FILES[id]) {
    ok(`file present ${rel}`, fs.existsSync(path.join(ROOT, rel)));
  }
}

const contract = readJson(CONTRACT_PATH);
const findings = readText(FINDINGS_PATH);
const doc = readText(DOC_PATH);

ok('contract slice FACTORY-1B', contract.slice === locks.SLICE);
ok('contract master basis pinned', contract.master_basis === locks.MASTER_BASIS);
ok('contract outcome id', contract.outcome_id === locks.OUTCOME_ID);
ok('contract archetypes deep-equal locks', locks.deepEqual(
  contract.archetypes,
  locks.thaw(Object.values(locks.ARCHETYPE_LOCKS).map((a) => ({
    id: a.id,
    label: a.label,
    reference_client_slug: a.reference_client_slug,
    reference_location_ids: a.reference_location_ids,
    reference_baseline: a.reference_baseline,
    legacy_vertical: a.legacy_vertical,
    portal_default_tab: a.portal_default_tab,
    location_cardinality: a.location_cardinality,
    inventory_model: a.inventory_model,
  }))),
));
ok('findings cite master basis', findings.includes(locks.MASTER_BASIS));
ok('findings name both archetypes', /surf_house/.test(findings) && /surf_school_shop/.test(findings));
ok('doc marks 1B delivered', /1B/.test(doc) && /delivered|complete|templates/i.test(doc));
ok('doc names config/archetypes', /config\/archetypes/.test(doc));

// ── No generator / runtime productization surfaces ──────────────────────────
console.log('\n── Scope fence (no generator/runtime/IaC) ──');
ok('no forbidden productization paths',
  locks.FORBIDDEN_PRODUCTIZATION_PATHS.every((p) => !fs.existsSync(path.join(ROOT, p))));
ok('no client instance baselines under archetypes', (() => {
  const root = path.join(ROOT, 'config/archetypes');
  const hit = [];
  function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.baseline\.json$/.test(ent.name) && !/\.template\.json$/.test(ent.name)) {
        hit.push(p);
      }
    }
  }
  walk(root);
  return hit.length === 0;
})());

// ── Preserve Wolfhouse/Sunset reference bytes (working-tree vs master) ───────
console.log('\n── Preserve reference pair bytes (working-tree vs master) ──');
{
  const errs = locks.validateReferenceBytesAgainstMaster(ROOT);
  ok('working-tree reference bytes match master blobs',
    errs.length === 0,
    errs.slice(0, 6).join(','));
  for (const [rel, sha] of Object.entries(locks.PRESERVED_REFERENCE_BLOBS)) {
    const wt = locks.workingTreeBlobShaSafe(ROOT, rel);
    ok(`wt hash-object ${rel}`, wt === sha, `got ${wt}`);
  }
}

// ── Schema / cross-file / isolation GREEN ───────────────────────────────────
console.log('\n── Template schema + cross-file + isolation ──');
const house = loadArchetypeBundle('surf_house');
const school = loadArchetypeBundle('surf_school_shop');

{
  const e = [
    ...locks.validateManifest(house.manifest, 'surf_house'),
    ...locks.validateCompatibility(house.compatibility, 'surf_house'),
    ...locks.validateBaselineTemplate(house.baseline, 'surf_house'),
    ...locks.validatePricingTemplate(house.pricing),
    ...locks.validateCrossFileReferences({ ...house, archetypeId: 'surf_house' }),
  ];
  green('G1_surf_house_schema_valid', e.length === 0, e.slice(0, 12).join(','));
}
{
  const e = [
    ...locks.validateManifest(school.manifest, 'surf_school_shop'),
    ...locks.validateCompatibility(school.compatibility, 'surf_school_shop'),
    ...locks.validateBaselineTemplate(school.baseline, 'surf_school_shop'),
    ...locks.validateCrossFileReferences({ ...school, archetypeId: 'surf_school_shop' }),
  ];
  green('G2_surf_school_shop_schema_valid', e.length === 0, e.slice(0, 12).join(','));
}

green('G3_tenant_location_isolation',
  locks.validateTenantLocationIsolation(
    { baseline: house.baseline, compatibility: house.compatibility },
    { baseline: school.baseline, compatibility: school.compatibility },
  ).length === 0);

{
  const texts = [];
  for (const id of locks.ARCHETYPE_IDS) {
    for (const rel of locks.ARCHETYPE_FILES[id]) {
      texts.push(readText(path.join(ROOT, rel)));
    }
  }
  const hits = locks.scanForbiddenContent(texts.join('\n'));
  green('G4_no_secret_or_live_target_content', hits.length === 0, hits.join(','));
}

green('G5_all_enablement_off',
  locks.validateEnablementOff(house.baseline, 'surf_house').length === 0
  && locks.validateEnablementOff(school.baseline, 'surf_school_shop').length === 0);

{
  const enumErrs = locks.validateArchetypeFileSets(ROOT);
  const enumerated = locks.enumerateArchetypeFileSets(ROOT);
  green('G6_exact_archetype_file_set',
    enumErrs.length === 0
    && locks.deepEqual(enumerated.dirs, ['surf_house', 'surf_school_shop'])
    && locks.deepEqual(enumerated.files.surf_house, [...locks.ARCHETYPE_FILES.surf_house].sort())
    && locks.deepEqual(
      enumerated.files.surf_school_shop,
      [...locks.ARCHETYPE_FILES.surf_school_shop].sort(),
    ),
    enumErrs.slice(0, 4).join(','));
}

green('G7_pricing_quote_calculator_shape',
  locks.validatePricingTemplate(house.pricing).length === 0
  && house.pricing
  && !Object.prototype.hasOwnProperty.call(house.pricing, 'addons')
  && !Object.prototype.hasOwnProperty.call(house.pricing, 'deposit')
  && !!house.pricing.add_ons
  && !!house.pricing.deposits
  && !!house.pricing.room_supplements
  && !!house.pricing.rounding
  && !!house.pricing.hold);

// ── Adversarial REDs ────────────────────────────────────────────────────────
console.log('\n── Adversarial REDs ──');

{
  const bad = clone(house);
  bad.baseline.secrets.stripe_embedded = ['sk', 'live', '51FakeLiveSecretValue0001'].join('_');
  const tmp = writeTempBundle({ surf_house: bad, surf_school_shop: school });
  try {
    const r = validateBundleFromDisk(tmp, 'surf_house');
    red('R1_secret_shaped_stripe_live_rejected',
      r.errors.some((e) => /forbidden_content:stripe_live_secret/.test(e)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const bad = clone(school);
  bad.baseline.deployment.public_api = 'https://staff-staging.lunafrontdesk.com';
  const tmp = writeTempBundle({ surf_house: house, surf_school_shop: bad });
  try {
    const r = validateBundleFromDisk(tmp, 'surf_school_shop');
    red('R2_live_hostname_rejected',
      r.errors.some((e) => /forbidden_content:(?:live_hostname|copied_live_staff_host)/.test(e)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const bad = clone(school);
  bad.baseline.deployment.whatsapp_phone_number_id = '123456789012345';
  const text = JSON.stringify(bad.baseline);
  const hits = locks.scanForbiddenContent(text);
  const schemaErrs = locks.validateEnablementOff(bad.baseline, 'surf_school_shop');
  red('R3_meta_phone_number_id_rejected',
    hits.includes('meta_phone_number_id_value')
    || schemaErrs.includes('whatsapp_phone_number_id_must_be_null'));
}

{
  const bad = clone(house);
  bad.baseline.deployment.azure_id =
    '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/wh-prod-rg';
  const hits = locks.scanForbiddenContent(JSON.stringify(bad.baseline));
  red('R4_azure_ids_rejected',
    hits.includes('azure_subscription') || hits.includes('azure_resource_id'));
}

{
  const bad = clone(house);
  delete bad.baseline.packages;
  const errs = locks.validateBaselineTemplate(bad.baseline, 'surf_house');
  red('R5_missing_required_pricing_field_rejected',
    errs.some((e) => /baseline:packages\./.test(e) || e === 'surf_house_packages_missing'));
}

{
  const bad = clone(school);
  bad.baseline.live_enabled = true;
  bad.baseline.channels.whatsapp.enabled = true;
  bad.baseline.deployment.enabled = true;
  bad.baseline.payment.payment_link_auto_allowed = true;
  const errs = locks.validateEnablementOff(bad.baseline, 'surf_school_shop');
  red('R6_default_enable_rejected',
    errs.includes('enablement_not_false:live_enabled')
    && errs.includes('enablement_not_false:channels.whatsapp.enabled')
    && errs.includes('enablement_not_false:deployment.enabled')
    && errs.includes('enablement_not_false:payment.payment_link_auto_allowed'));
}

{
  const bad = clone(house);
  bad.baseline._meta.client_slug = 'wolfhouse';
  const errs = locks.validateBaselineTemplate(bad.baseline, 'surf_house');
  red('R7_copied_live_client_slug_rejected',
    errs.includes('baseline_client_slug_not_placeholder')
    || errs.includes('baseline_client_slug_copied_live_target'));
}

{
  const bad = clone(school);
  bad.baseline.locations = [
    { location_id: 'sunset-somo', display_name: 'x' },
    { location_id: 'sunset-sardinero', display_name: 'y' },
  ];
  const errs = locks.validateBaselineTemplate(bad.baseline, 'surf_school_shop');
  red('R8_copied_live_location_ids_rejected',
    errs.includes('surf_school_shop_location_id_not_placeholder')
    || errs.includes('surf_school_shop_location_copied_live_target'));
}

{
  const badHouse = clone(house);
  const badSchool = clone(school);
  badSchool.compatibility.registry_shape.location_id_placeholders = [
    '{{LOCATION_ID}}',
    '{{LOCATION_ID_X}}',
  ];
  const errs = locks.validateTenantLocationIsolation(
    { baseline: badHouse.baseline, compatibility: badHouse.compatibility },
    { baseline: badSchool.baseline, compatibility: badSchool.compatibility },
  );
  red('R9_location_placeholder_collision_rejected',
    errs.includes('archetype_location_placeholders_collide'));
}

{
  const bad = clone(house);
  delete bad.baseline.features.portal_default_tab;
  const errs = locks.validateBaselineTemplate(bad.baseline, 'surf_house');
  red('R10_missing_features_field_rejected',
    errs.some((e) => e.includes('features.portal_default_tab')));
}

{
  const bad = clone(school);
  bad.baseline.db_url = 'postgres://staff:password@db.postgres.database.azure.com/app';
  const hits = locks.scanForbiddenContent(JSON.stringify(bad.baseline));
  red('R11_db_credential_url_rejected',
    hits.includes('postgres_url') || hits.includes('live_hostname'));
}

{
  const bad = clone(house);
  bad.baseline.confirmation.confirmation_send_mode = 'auto_after_payment_truth';
  const errs = locks.validateEnablementOff(bad.baseline, 'surf_house');
  red('R12_live_send_mode_rejected',
    errs.some((e) => /confirmation_send_mode_not_gated/.test(e)));
}

{
  const bad = clone(house);
  for (const pkg of bad.pricing.packages) delete pkg.seasonal_prices;
  const errs = locks.validatePricingTemplate(bad.pricing);
  red('R13_seasonal_prices_deletion_rejected',
    errs.some((e) => /pricing_seasonal_prices_missing/.test(e)));
}

{
  const bad = clone(school);
  const first = Object.keys(bad.baseline.catalog.rentals.offerings)[0];
  delete bad.baseline.catalog.rentals.offerings[first].prices_eur;
  const errs = locks.validateBaselineTemplate(bad.baseline, 'surf_school_shop');
  red('R14_rental_prices_eur_deletion_rejected',
    errs.some((e) => /rental_prices_eur_missing/.test(e)));
}

{
  const bad = clone(school);
  delete bad.baseline.catalog.lessons.scheduling.common_slot_times;
  const errs = locks.validateBaselineTemplate(bad.baseline, 'surf_school_shop');
  red('R15_schedule_field_deletion_rejected',
    errs.some((e) => (
      /lessons_scheduling_common_slot_times_missing/.test(e)
      || /baseline:catalog\.lessons\.scheduling\.common_slot_times/.test(e)
    )));
}

{
  const bad = clone(school);
  bad.baseline.locations = [
    { location_id: '{{LOCATION_ID_1}}', display_name: 'a' },
    { location_id: '{{LOCATION_ID_1}}', display_name: 'b' },
  ];
  const errs = locks.validateBaselineTemplate(bad.baseline, 'surf_school_shop');
  red('R16_duplicate_location_ids_rejected',
    errs.includes('surf_school_shop_location_id_duplicate'));
}

{
  const bad = clone(school);
  bad.compatibility.registry_shape.location_id_placeholders = [
    '{{LOCATION_ID_1}}',
    '{{LOCATION_ID_DRIFT}}',
  ];
  const errs = locks.validatePlaceholderAlignment({
    ...bad,
    archetypeId: 'surf_school_shop',
    pricing: null,
  });
  red('R17_baseline_compat_location_placeholder_drift_rejected',
    errs.includes('placeholder_drift:LOCATION_IDS'));
}

{
  const bad = clone(house);
  bad.pricing.addons = bad.pricing.add_ons;
  delete bad.pricing.add_ons;
  const errs = locks.validatePricingTemplate(bad.pricing);
  red('R18_invented_addons_key_rejected',
    errs.some((e) => e === 'pricing_invented_key:addons' || e === 'pricing_add_ons_missing'));
}

{
  const bad = clone(house);
  bad.pricing.deposit = {
    type: 'tiered_by_booking_type',
    tiers: bad.pricing.deposits.tiers,
  };
  delete bad.pricing.deposits;
  const errs = locks.validatePricingTemplate(bad.pricing);
  red('R19_invented_deposit_shape_rejected',
    errs.some((e) => (
      e === 'pricing_invented_key:deposit'
      || /pricing:deposits/.test(e)
    )));
}

{
  const rel = 'config/clients/wolfhouse-somo.pricing.json';
  const abs = path.join(ROOT, rel);
  const original = fs.readFileSync(abs);
  try {
    fs.writeFileSync(abs, Buffer.concat([original, Buffer.from('\n')]));
    const errs = locks.validateReferenceBytesAgainstMaster(ROOT);
    red('R20_reference_worktree_mutation_rejected',
      errs.some((e) => /reference_worktree_blob_drift:config\/clients\/wolfhouse-somo\.pricing\.json/.test(e)));
  } finally {
    fs.writeFileSync(abs, original);
  }
}

{
  const bad = clone(house);
  bad.compatibility.reference_location_ids = ['wolfhouse-somo', 'invented-extra'];
  const errs = locks.validatePlaceholderAlignment({
    ...bad,
    archetypeId: 'surf_house',
  });
  const compatErrs = locks.validateCompatibility(bad.compatibility, 'surf_house');
  red('R21_coordinated_lock_compat_drift_rejected',
    errs.includes('coordinated_lock_compat_drift:reference_location_ids')
    || compatErrs.includes('compat_reference_locations_mismatch'));
}

{
  const tmp = writeTempBundle({ surf_house: house, surf_school_shop: school });
  try {
    fs.writeFileSync(
      path.join(tmp, 'config/archetypes/surf_house/extra.json'),
      JSON.stringify({ extra: true }),
    );
    const errs = locks.validateArchetypeFileSets(tmp);
    red('R22_extra_archetype_file_rejected',
      errs.some((e) => /file_set_mismatch:surf_house/.test(e)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const bad = clone(house);
  bad.pricing.packages[0].code = '{{PACKAGE_CODE_X}}';
  const errs = locks.validatePlaceholderAlignment({
    ...bad,
    archetypeId: 'surf_house',
  });
  red('R23_package_code_cross_ref_drift_rejected',
    errs.includes('placeholder_drift:PACKAGE_CODES'));
}

{
  const bad = clone(house);
  bad.pricing.add_ons.surf_lesson_multi = {
    code: 'surf_lesson_multi',
    pricing_unit: 'per_lesson',
    pricing_model: 'tiered_by_quantity',
    tiers: [{ min_qty: 2, price_cents_each: '{{PRICE_CENTS_PLACEHOLDER}}' }],
  };
  const errs = locks.validatePricingTemplate(bad.pricing);
  red('R24_invented_lesson_tiers_rejected',
    errs.includes('pricing_invented_lesson_tiers')
    || errs.includes('pricing_surf_lesson_multi_price_cents_each_missing'));
}

{
  const bad = clone(school);
  const first = Object.keys(bad.baseline.catalog.lessons.offerings)[0];
  delete bad.baseline.catalog.lessons.offerings[first].prices_eur;
  const errs = locks.validateBaselineTemplate(bad.baseline, 'surf_school_shop');
  red('R25_lesson_prices_eur_deletion_rejected',
    errs.some((e) => /lesson_prices_eur_missing/.test(e)));
}

{
  const bad = clone(house);
  bad.baseline.packages.known_packages = ['{{PACKAGE_CODE_1}}'];
  // leave prices matrix with three packages → missing/alignment failure on deep validate
  const errs = locks.validateBaselineTemplate(bad.baseline, 'surf_house');
  const align = locks.validatePlaceholderAlignment({
    ...bad,
    archetypeId: 'surf_house',
  });
  red('R26_package_matrix_cross_ref_drift_rejected',
    errs.some((e) => /surf_house_prices_missing_package/.test(e))
    || align.includes('placeholder_drift:PACKAGE_CODES'));
}

// ── Tip scope ───────────────────────────────────────────────────────────────
console.log('\n── Tip scope ──');
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
  try {
    const untracked = execSync('git ls-files --others --exclude-standard', {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);
    changed = Array.from(new Set(changed.concat(untracked)));
  } catch (_) { /* ignore */ }
  changed = changed.filter((p) => !p.startsWith('tmp/'));
  const scope = tipPathsAllowed(changed);
  ok('tip paths within locked prefixes', scope.ok, scope.bad.slice(0, 12).join(','));
}

{
  const pkg = readJson(path.join(ROOT, 'package.json'));
  const val = pkg.scripts && pkg.scripts[locks.PACKAGE_JSON_ALLOWED_SCRIPT_KEY];
  ok('package.json registers 1B verifier script',
    val === locks.PACKAGE_JSON_ALLOWED_SCRIPT_VALUE);
}

// ── Existing regressions ────────────────────────────────────────────────────
console.log('\n── Existing regressions ──');
function runNodeScript(relScript) {
  return spawnSync(process.execPath, [path.join(ROOT, relScript)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    timeout: 180000,
  });
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

// Nested 1A: skip when this verifier is itself probing for the 1A ledger gate
// (avoids recursion). FACTORY_1B_LEDGER_PROBE=1 is set by the 1A verifier.
if (process.env.FACTORY_1B_LEDGER_PROBE === '1') {
  ok('ledger probe skips nested 1A (independent core already validated)', true);
} else {
  const r = spawnSync('npm', ['run', 'verify:factory-slice1a-acceptance-contract'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, FACTORY_1A_SKIP_NESTED_1B: '1' },
    timeout: 180000,
    shell: true,
  });
  ok('verify:factory-slice1a-acceptance-contract exit 0',
    r.status === 0,
    r.status !== 0 ? (r.stderr || r.stdout || '').slice(-500) : '');
}

console.log(`\n── factory-slice1b: ${pass} passed, ${fail} failed ──`);
console.log(`  RED ${redResults.filter((r) => r.ok).length}/${redResults.length}  GREEN ${greenResults.filter((g) => g.ok).length}/${greenResults.length}`);

if (fail > 0) process.exit(1);
console.log('FACTORY Slice 1B archetype templates: PASS');
process.exit(0);
