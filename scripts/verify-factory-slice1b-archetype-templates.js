'use strict';

/**
 * verify:factory-slice1b-archetype-templates — FACTORY Slice 1B
 *
 * Independent static verifier for reviewed archetype templates under
 * config/archetypes/. Exact schemas, cross-file refs, tenant/location
 * isolation, and adversarial secret/live-target/missing-field/default-enable
 * REDs. No network, no DB, no generator, no runtime loading, no deploy.
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

function gitBlobSha(rel) {
  try {
    return execSync(`git rev-parse HEAD:${rel}`, {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch (err) {
    return `__missing__:${err && err.message}`;
  }
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

// ── Preserve Wolfhouse/Sunset reference bytes ───────────────────────────────
console.log('\n── Preserve reference pair bytes ──');
for (const [rel, sha] of Object.entries(locks.PRESERVED_REFERENCE_BLOBS)) {
  ok(`unchanged blob ${rel}`, gitBlobSha(rel) === sha, `got ${gitBlobSha(rel)}`);
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
  green('G1_surf_house_schema_valid', e.length === 0, e.slice(0, 8).join(','));
}
{
  const e = [
    ...locks.validateManifest(school.manifest, 'surf_school_shop'),
    ...locks.validateCompatibility(school.compatibility, 'surf_school_shop'),
    ...locks.validateBaselineTemplate(school.baseline, 'surf_school_shop'),
    ...locks.validateCrossFileReferences({ ...school, archetypeId: 'surf_school_shop' }),
  ];
  green('G2_surf_school_shop_schema_valid', e.length === 0, e.slice(0, 8).join(','));
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

green('G6_exact_archetype_file_set',
  locks.deepEqual(
    Object.keys(locks.ARCHETYPE_FILES).sort(),
    ['surf_house', 'surf_school_shop'],
  )
  && locks.ARCHETYPE_FILES.surf_house.length === 5
  && locks.ARCHETYPE_FILES.surf_school_shop.length === 4);

// ── Adversarial REDs ────────────────────────────────────────────────────────
console.log('\n── Adversarial REDs ──');

{
  const bad = clone(house);
  // Assemble without a literal sk_live_… token so push protection is not tripped.
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
  // Force a location-token collision across archetypes.
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
  // Untracked new files in this worktree also count for local validation.
  try {
    const untracked = execSync('git ls-files --others --exclude-standard', {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);
    changed = Array.from(new Set(changed.concat(untracked)));
  } catch (_) { /* ignore */ }
  // Ignore unrelated tmp/ scratch noise.
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

{
  const r = spawnSync('npm', ['run', 'verify:factory-slice1a-acceptance-contract'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
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
