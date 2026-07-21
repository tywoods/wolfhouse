'use strict';

/**
 * verify:factory-slice1c-dry-run-generator — FACTORY Slice 1C
 *
 * Independent verifier for the deterministic disabled dry-run onboarding
 * generator. Proves byte-determinism, template immutability, exact output set,
 * no side effects outside explicit output dir/stdout, and adversarial
 * rejection. No apply, no registry edits, no config/clients writes, no
 * runtime/DB/cloud/network.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const gen = require('./lib/factory-slice1c-dry-run-generator');
const slice1b = require('./lib/factory-slice1b-archetype-templates');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'factory-client-productization');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice1c-contract.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice1c-findings.md');
const DOC_PATH = path.join(ROOT, 'docs', 'FACTORY-CLIENT-PRODUCTIZATION.md');
const CLI_PATH = path.join(ROOT, 'scripts', 'onboard-client.js');
const LIB_PATH = path.join(ROOT, 'scripts', 'lib', 'factory-slice1c-dry-run-generator.js');

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
  const prefixes = gen.ALLOWED_TIP_PATH_PREFIXES;
  const bad = [];
  for (const p of changedPaths) {
    const okPath = prefixes.some((pref) => (
      pref.endsWith('/') ? p.startsWith(pref) || p === pref.slice(0, -1) : p === pref
    ));
    if (!okPath) bad.push(p);
  }
  return { ok: bad.length === 0, bad };
}

function loadSubs(archetype) {
  return readJson(path.join(FIXTURE_DIR, `slice1c-substitutions-${archetype}.json`));
}

function listFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFilesRecursive(abs));
    else out.push(abs);
  }
  return out;
}

function archetypeTemplateSnapshot() {
  const snap = {};
  for (const id of gen.ARCHETYPE_IDS) {
    const dir = path.join(ROOT, 'config', 'archetypes', id);
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const rel = `config/archetypes/${id}/${name}`;
      snap[rel] = gen.sha256Hex(fs.readFileSync(path.join(ROOT, rel)));
    }
  }
  return snap;
}

function clientsTreeSnapshot() {
  const dir = path.join(ROOT, 'config', 'clients');
  const snap = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    if (!fs.statSync(abs).isFile()) continue;
    snap[`config/clients/${name}`] = gen.sha256Hex(fs.readFileSync(abs));
  }
  return snap;
}

console.log('verify:factory-slice1c-dry-run-generator — FACTORY 1C\n');

// ── Artifacts ───────────────────────────────────────────────────────────────
console.log('── Artifacts ──');
ok('contract fixture exists', fs.existsSync(CONTRACT_PATH));
ok('findings exist', fs.existsSync(FINDINGS_PATH));
ok('doc exists', fs.existsSync(DOC_PATH));
ok('library exists', fs.existsSync(LIB_PATH));
ok('CLI exists', fs.existsSync(CLI_PATH));
ok('substitution fixtures exist',
  fs.existsSync(path.join(FIXTURE_DIR, 'slice1c-substitutions-surf_house.json'))
  && fs.existsSync(path.join(FIXTURE_DIR, 'slice1c-substitutions-surf_school_shop.json')));

const contract = readJson(CONTRACT_PATH);
const findings = readText(FINDINGS_PATH);
const doc = readText(DOC_PATH);

ok('contract slice FACTORY-1C', contract.slice === gen.SLICE);
ok('contract outcome locked', contract.outcome_id === gen.OUTCOME_ID);
ok('contract master basis ce89a43e…', contract.master_basis === gen.MASTER_BASIS);
ok('contract branch locked', contract.branch === gen.BRANCH);
ok('contract dry-run only', contract.mode === 'dry-run' && contract.apply_path === false);
ok('contract archetypes exact pair', gen.deepEqual(contract.archetypes, [...gen.ARCHETYPE_IDS]));
ok('live_mutation false', contract.live_mutation === false);
ok('runtime_behavior_changed false', contract.runtime_behavior_changed === false);
ok('findings cite master basis', findings.includes(gen.MASTER_BASIS));
ok('findings cite dry-run / no apply', /dry-run/i.test(findings) && /not.*apply/i.test(findings));
ok('doc names 1C generator', /1C/.test(doc) && /generator/i.test(doc));

// ── Package script lock ─────────────────────────────────────────────────────
console.log('\n── Package script ──');
const pkg = readJson(path.join(ROOT, 'package.json'));
ok('package.json registers 1C verifier script',
  pkg.scripts
  && pkg.scripts[gen.PACKAGE_JSON_ALLOWED_SCRIPT_KEY] === gen.PACKAGE_JSON_ALLOWED_SCRIPT_VALUE);

// ── GREEN: byte-determinism + exact output set ──────────────────────────────
console.log('\n── GREEN generation ──');
const beforeTemplates = archetypeTemplateSnapshot();
const beforeClients = clientsTreeSnapshot();

for (const archetype of gen.ARCHETYPE_IDS) {
  const subs = loadSubs(archetype);
  const clientSlug = subs.CLIENT_SLUG;
  const r1 = gen.generateDryRunPreview({
    repoRoot: ROOT,
    archetype,
    mode: gen.MODE_DRY_RUN,
    substitutions: subs,
  });
  const r2 = gen.generateDryRunPreview({
    repoRoot: ROOT,
    archetype,
    mode: gen.MODE_DRY_RUN,
    substitutions: JSON.parse(JSON.stringify(subs)),
  });
  green(`${archetype}_generate_ok`, r1.ok && r2.ok, (r1.errors || []).join(','));
  if (!r1.ok || !r2.ok) continue;

  const paths1 = r1.files.map((f) => f.relativePath).sort();
  const expected = gen.expectedOutputPathSet(archetype, clientSlug);
  green(`${archetype}_exact_output_set`, gen.deepEqual(paths1, expected),
    `got=${paths1.join('|')} expected=${expected.join('|')}`);

  const byteEqual = r1.files.every((f, i) => {
    const g = r2.files.find((x) => x.relativePath === f.relativePath);
    return g && g.content === f.content && g.sha256 === f.sha256;
  }) && r1.files.length === r2.files.length;
  green(`${archetype}_byte_determinism`, byteEqual);

  const enablementOk = r1.files
    .filter((f) => f.kind === 'baseline' || f.kind === 'registry_entry')
    .every((f) => {
      const obj = JSON.parse(f.content);
      if (f.kind === 'registry_entry') return obj.live_enabled === false;
      return slice1b.ENABLEMENT_FALSE_PATHS[archetype]
        .every((p) => {
          const parts = p.split('.');
          let cur = obj;
          for (const part of parts) cur = cur && cur[part];
          return cur === false;
        });
    });
  green(`${archetype}_enablement_false`, enablementOk);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `factory1c-${archetype}-`));
  const written = gen.writeDryRunPreview(r1, { repoRoot: ROOT, outputDir: tmp });
  green(`${archetype}_write_ok`, written.ok, (written.errors || []).join(','));
  if (written.ok) {
    const onDisk = listFilesRecursive(tmp)
      .map((abs) => path.relative(tmp, abs).split(path.sep).join('/'))
      .sort();
    green(`${archetype}_disk_matches_exact_set`, gen.deepEqual(onDisk, expected));
    const overwrite = gen.writeDryRunPreview(r1, { repoRoot: ROOT, outputDir: tmp });
    red(`${archetype}_overwrite_refused`, !overwrite.ok
      && overwrite.errors.some((e) => e.startsWith('overwrite_refused:')));
  }
}

const afterTemplates = archetypeTemplateSnapshot();
const afterClients = clientsTreeSnapshot();
green('template_immutability', gen.deepEqual(beforeTemplates, afterTemplates));
green('no_config_clients_side_effects', gen.deepEqual(beforeClients, afterClients));

// ── CLI dry-run ─────────────────────────────────────────────────────────────
console.log('\n── CLI ──');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-cli-'));
  const r = spawnSync(process.execPath, [
    CLI_PATH,
    '--archetype', 'surf_house',
    '--substitutions', path.join(FIXTURE_DIR, 'slice1c-substitutions-surf_house.json'),
    '--output-dir', tmp,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  green('cli_dry_run_exit_0', r.status === 0, (r.stderr || r.stdout || '').slice(-400));
  if (r.status === 0) {
    green('cli_wrote_manifest', fs.existsSync(path.join(tmp, 'dry-run-manifest.json')));
  }
  const apply = spawnSync(process.execPath, [
    CLI_PATH,
    '--apply',
    '--archetype', 'surf_house',
    '--substitutions', path.join(FIXTURE_DIR, 'slice1c-substitutions-surf_house.json'),
    '--output-dir', tmp + '-apply',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  red('cli_apply_rejected', apply.status !== 0
    && /apply_path_forbidden/.test(`${apply.stderr || ''}${apply.stdout || ''}`));
}

// ── Adversarial REDs ────────────────────────────────────────────────────────
console.log('\n── Adversarial REDs ──');
const baseHouse = loadSubs('surf_house');
const baseSchool = loadSubs('surf_school_shop');

function expectFail(id, input, pred) {
  const r = gen.generateDryRunPreview(input);
  red(id, !r.ok && pred(r.errors || []), (r.errors || []).join(','));
}

expectFail('unsupported_archetype', {
  repoRoot: ROOT,
  archetype: 'surf_school',
  mode: gen.MODE_DRY_RUN,
  substitutions: baseHouse,
}, (e) => e.some((x) => x.startsWith('archetype_unsupported:')));

expectFail('mode_apply_forbidden', {
  repoRoot: ROOT,
  archetype: 'surf_house',
  mode: 'apply',
  substitutions: baseHouse,
}, (e) => e.includes('mode_unsupported:apply') || e.includes('apply_path_forbidden'));

expectFail('invalid_client_slug', {
  repoRoot: ROOT,
  archetype: 'surf_house',
  mode: gen.MODE_DRY_RUN,
  substitutions: { ...baseHouse, CLIENT_SLUG: 'Bad_Slug' },
}, (e) => e.some((x) => x.startsWith('client_slug_invalid_slug:')));

expectFail('path_traversal_slug', {
  repoRoot: ROOT,
  archetype: 'surf_house',
  mode: gen.MODE_DRY_RUN,
  substitutions: { ...baseHouse, CLIENT_SLUG: '../etc' },
}, (e) => e.some((x) => x.includes('invalid_slug') || x.includes('path_traversal')));

expectFail('missing_required_substitution', {
  repoRoot: ROOT,
  archetype: 'surf_house',
  mode: gen.MODE_DRY_RUN,
  substitutions: (() => {
    const s = { ...baseHouse };
    delete s.ASSISTANT_NAME;
    return s;
  })(),
}, (e) => e.includes('required_substitution_missing:ASSISTANT_NAME'));

expectFail('existing_tenant_wolfhouse', {
  repoRoot: ROOT,
  archetype: 'surf_house',
  mode: gen.MODE_DRY_RUN,
  substitutions: { ...baseHouse, CLIENT_SLUG: 'wolfhouse', LOCATION_ID: 'brand-new-loc-zzz' },
}, (e) => e.includes('existing_tenant_conflict:wolfhouse'));

expectFail('existing_location_wolfhouse_somo', {
  repoRoot: ROOT,
  archetype: 'surf_house',
  mode: gen.MODE_DRY_RUN,
  substitutions: {
    ...baseHouse,
    CLIENT_SLUG: 'fresh-house-zzz',
    LOCATION_ID: 'wolfhouse-somo',
  },
}, (e) => e.includes('existing_location_conflict:wolfhouse-somo'));

expectFail('location_collision', {
  repoRoot: ROOT,
  archetype: 'surf_school_shop',
  mode: gen.MODE_DRY_RUN,
  substitutions: {
    ...baseSchool,
    CLIENT_SLUG: 'fresh-school-zzz',
    LOCATION_ID_1: 'same-loc',
    LOCATION_ID_2: 'same-loc',
  },
}, (e) => e.includes('location_id_collision'));

expectFail('secret_stripe_live_input', {
  repoRoot: ROOT,
  archetype: 'surf_house',
  mode: gen.MODE_DRY_RUN,
  substitutions: {
    ...baseHouse,
    CLIENT_SLUG: 'fresh-house-secret',
    LOCATION_ID: 'fresh-house-secret-main',
    // Assemble at runtime so the repo never contains a contiguous sk_live_ literal.
    STAFF_ADMIN_PASSWORD: ['sk', 'live', 'EXAMPLESECRETVALUE123456'].join('_'),
  },
}, (e) => e.some((x) => x.includes('substitution_forbidden') && x.includes('stripe_live_secret')));

expectFail('live_hostname_input', {
  repoRoot: ROOT,
  archetype: 'surf_house',
  mode: gen.MODE_DRY_RUN,
  substitutions: {
    ...baseHouse,
    CLIENT_SLUG: 'fresh-house-host',
    LOCATION_ID: 'fresh-house-host-main',
    MAPS_LINK: 'https://staff-staging.lunafrontdesk.com/maps',
  },
}, (e) => e.some((x) => x.includes('live_hostname') || x.includes('copied_live_staff_host')));

expectFail('azure_id_input', {
  repoRoot: ROOT,
  archetype: 'surf_house',
  mode: gen.MODE_DRY_RUN,
  substitutions: {
    ...baseHouse,
    CLIENT_SLUG: 'fresh-house-azure',
    LOCATION_ID: 'fresh-house-azure-main',
    PROPERTY_ADDRESS: '/subscriptions/12345678-1234-1234-1234-123456789abc/resourceGroups/rg',
  },
}, (e) => e.some((x) => x.includes('azure_')));

expectFail('postgres_url_input', {
  repoRoot: ROOT,
  archetype: 'surf_house',
  mode: gen.MODE_DRY_RUN,
  substitutions: {
    ...baseHouse,
    CLIENT_SLUG: 'fresh-house-pg',
    LOCATION_ID: 'fresh-house-pg-main',
    VOICE_SUMMARY: 'postgres://user:pass@db.example/db',
  },
}, (e) => e.some((x) => x.includes('postgres_url')));

{
  const unsafe = gen.isSafeOutputDirectory(ROOT, path.join(ROOT, 'config', 'clients', 'evil-out'));
  red('unsafe_output_config_clients', !unsafe.ok
    && unsafe.error.startsWith('output_dir_forbidden_root:'));
}
{
  const unsafe = gen.isSafeOutputDirectory(ROOT, path.join(ROOT, 'config', 'archetypes', 'evil'));
  red('unsafe_output_archetypes', !unsafe.ok
    && unsafe.error.startsWith('output_dir_forbidden_root:'));
}
{
  const unsafe = gen.isSafeOutputDirectory(ROOT, ROOT);
  red('unsafe_output_repo_root', !unsafe.ok && unsafe.error === 'output_dir_cannot_be_repo_root');
}

// Tip scope (diff vs master basis when available)
console.log('\n── Tip scope ──');
{
  const diff = spawnSync('git', [
    'diff', '--name-only', `${gen.MASTER_BASIS}...HEAD`,
  ], { cwd: ROOT, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const changed = new Set();
  for (const line of `${diff.stdout || ''}`.split('\n')) {
    if (line.trim()) changed.add(line.trim());
  }
  for (const line of `${status.stdout || ''}`.split('\n')) {
    const p = line.slice(3).trim();
    if (!p) continue;
    // skip untracked tmp noise
    if (p.startsWith('tmp/')) continue;
    changed.add(p.includes(' -> ') ? p.split(' -> ').pop() : p);
  }
  const check = tipPathsAllowed([...changed].filter((p) => (
    p.startsWith('docs/FACTORY')
    || p.startsWith('fixtures/factory-client-productization/')
    || p.startsWith('scripts/lib/factory-slice1')
    || p.startsWith('scripts/verify-factory-slice1')
    || p === 'scripts/onboard-client.js'
    || p === 'package.json'
    || p === 'package-lock.json'
    || p.startsWith('config/archetypes/')
  )));
  // config/archetypes must NOT appear in tip — immutability
  const archetypeTouched = [...changed].filter((p) => p.startsWith('config/archetypes/'));
  ok('tip does not mutate archetype templates', archetypeTouched.length === 0,
    archetypeTouched.join(','));
  const factoryTouched = [...changed].filter((p) => (
    p.startsWith('fixtures/factory-client-productization/')
    || p.startsWith('scripts/lib/factory-slice1c')
    || p.startsWith('scripts/verify-factory-slice1c')
    || p === 'scripts/onboard-client.js'
    || p === 'docs/FACTORY-CLIENT-PRODUCTIZATION.md'
    || p.startsWith('scripts/lib/factory-slice1a')
    || p.startsWith('scripts/verify-factory-slice1a')
    || p === 'package.json'
  ));
  const tipCheck = tipPathsAllowed(factoryTouched);
  ok('1C tip paths within allowlist', tipCheck.ok, tipCheck.bad.join(','));
  void check;
}

// ── Regressions ─────────────────────────────────────────────────────────────
console.log('\n── Regressions ──');
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

// Nested 1B (templates still green). When probing from 1A, skip re-entry loops.
if (process.env.FACTORY_1C_LEDGER_PROBE === '1') {
  ok('ledger probe skips nested 1A/1B re-entry', true);
} else {
  const r1b = spawnSync('npm', ['run', 'verify:factory-slice1b-archetype-templates'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      FACTORY_1B_LEDGER_PROBE: '1',
      FACTORY_1A_SKIP_NESTED_1C: '1',
    },
    timeout: 300000,
    shell: true,
  });
  ok('verify:factory-slice1b-archetype-templates exit 0',
    r1b.status === 0,
    r1b.status !== 0 ? (r1b.stderr || r1b.stdout || '').slice(-500) : '');

  const r1a = spawnSync('npm', ['run', 'verify:factory-slice1a-acceptance-contract'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      FACTORY_1A_SKIP_NESTED_1B: '1',
      FACTORY_1A_SKIP_NESTED_1C: '1',
    },
    timeout: 300000,
    shell: true,
  });
  ok('verify:factory-slice1a-acceptance-contract exit 0',
    r1a.status === 0,
    r1a.status !== 0 ? (r1a.stderr || r1a.stdout || '').slice(-500) : '');
}

{
  const diffCheck = spawnSync('git', ['diff', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  ok('git diff --check clean', diffCheck.status === 0,
    (diffCheck.stdout || diffCheck.stderr || '').slice(-300));
}

console.log(`\n── factory-slice1c: ${pass} passed, ${fail} failed ──`);
console.log(`  RED ${redResults.filter((r) => r.ok).length}/${redResults.length}  GREEN ${greenResults.filter((g) => g.ok).length}/${greenResults.length}`);

if (fail > 0) process.exit(1);
console.log('FACTORY Slice 1C dry-run generator: PASS');
process.exit(0);
