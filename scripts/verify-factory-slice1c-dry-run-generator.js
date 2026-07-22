'use strict';

/**
 * verify:factory-slice1c-dry-run-generator — FACTORY Slice 1C
 *
 * Independent verifier for the deterministic disabled dry-run onboarding
 * generator. Proves byte-determinism against independently locked golden
 * rendered-byte fixtures (without importing generator expectation helpers),
 * template immutability, atomic no-replace staging materialization safety, no side
 * effects outside explicit output dir, stdout zero-write, and adversarial
 * rejection. No apply, no registry edits, no config/clients writes, no
 * runtime/DB/cloud/network. Disk publish is Linux/GNU `/usr/bin/mv
 * --no-copy --no-clobber -T` only (sole local subprocess).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const gen = require('./lib/factory-slice1c-dry-run-generator');
const slice1b = require('./lib/factory-slice1b-archetype-templates');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'factory-client-productization');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice1c-contract.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice1c-findings.md');
const GOLDEN_LOCK_PATH = path.join(FIXTURE_DIR, 'slice1c-golden-lock.json');
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

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
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
      snap[rel] = sha256Hex(fs.readFileSync(path.join(ROOT, rel)));
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
    snap[`config/clients/${name}`] = sha256Hex(fs.readFileSync(abs));
  }
  return snap;
}

/**
 * Independent golden truth: locked output set + hashes + on-disk bytes.
 * Does not call generator path-set / preview-relative helpers.
 */
function loadIndependentGolden(archetype, goldenLock) {
  const entry = goldenLock.archetypes[archetype];
  if (!entry) throw new Error(`golden lock missing archetype ${archetype}`);
  const goldenDir = path.join(ROOT, entry.golden_dir);
  const lockedSet = [...entry.output_set].sort();
  const diskFiles = {};
  for (const rel of lockedSet) {
    const abs = path.join(goldenDir, rel);
    const bytes = fs.readFileSync(abs);
    const hash = sha256Hex(bytes);
    diskFiles[rel] = { bytes, hash, text: bytes.toString('utf8') };
    if (!entry.files[rel] || entry.files[rel].sha256 !== hash) {
      throw new Error(`golden lock hash drift for ${archetype}:${rel}`);
    }
  }
  return { entry, lockedSet, diskFiles, goldenDir };
}

console.log('verify:factory-slice1c-dry-run-generator — FACTORY 1C\n');

// ── Artifacts ───────────────────────────────────────────────────────────────
console.log('── Artifacts ──');
ok('contract fixture exists', fs.existsSync(CONTRACT_PATH));
ok('findings exist', fs.existsSync(FINDINGS_PATH));
ok('golden lock exists', fs.existsSync(GOLDEN_LOCK_PATH));
ok('doc exists', fs.existsSync(DOC_PATH));
ok('library exists', fs.existsSync(LIB_PATH));
ok('CLI exists', fs.existsSync(CLI_PATH));
ok('substitution fixtures exist',
  fs.existsSync(path.join(FIXTURE_DIR, 'slice1c-substitutions-surf_house.json'))
  && fs.existsSync(path.join(FIXTURE_DIR, 'slice1c-substitutions-surf_school_shop.json')));

const contract = readJson(CONTRACT_PATH);
const findings = readText(FINDINGS_PATH);
const doc = readText(DOC_PATH);
const goldenLock = readJson(GOLDEN_LOCK_PATH);

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
ok('findings cite output safety / golden',
  /atomic|staging|lstat|symlink|fd|proc|no-clobber|no-replace|\/usr\/bin\/mv/i.test(findings)
  && /golden/i.test(findings));
ok('findings cite sole local subprocess + Linux\/GNU boundary',
  /sole local subprocess/i.test(findings)
  && /Linux\/GNU/i.test(findings)
  && findings.includes('/usr/bin/mv')
  && findings.includes('--no-clobber'));
ok('doc cites GNU mv no-replace publish',
  doc.includes('/usr/bin/mv')
  && doc.includes('--no-clobber')
  && /Linux\/GNU/i.test(doc));
ok('doc names 1C generator', /1C/.test(doc) && /generator/i.test(doc));
ok('golden lock schema + both archetypes',
  goldenLock.schema_version === 1
  && goldenLock.archetypes
  && goldenLock.archetypes.surf_house
  && goldenLock.archetypes.surf_school_shop);

// Source fence: verifier golden path must not call generator expectation helpers.
{
  const verifierSrc = readText(path.join(ROOT, 'scripts', 'verify-factory-slice1c-dry-run-generator.js'));
  red('verifier_does_not_import_generator_expectations',
    !/\bgen\.expectedOutputPathSet\b/.test(verifierSrc)
    && !/\bgen\.previewRelativePaths\b/.test(verifierSrc)
    && !/\bgen\.buildFixtureSubstitutions\b/.test(verifierSrc));
}

// Source fence: disk publish must not use Node rename (empty-final replace surface).
{
  const libSrc = readText(LIB_PATH);
  red('lib_publish_does_not_use_fs_rename',
    !/\bfs\.renameSync\s*\(/.test(libSrc) && !/\bfs\.rename\s*\(/.test(libSrc),
    'fs.rename*(...) must not appear in 1C library publish path');
  red('lib_publish_uses_gnu_mv_no_replace',
    libSrc.includes(gen.GNU_MV_PATH)
    && libSrc.includes('--no-copy')
    && libSrc.includes('--no-clobber')
    && /spawnSync\s*\(\s*GNU_MV_PATH/.test(libSrc)
    && /shell:\s*false/.test(libSrc),
    'expected /usr/bin/mv --no-copy --no-clobber argument-array spawn');
  red('lib_documents_sole_local_subprocess',
    /sole local subprocess/i.test(libSrc));
  red('lib_post_spawn_ownership_inspect',
    libSrc.includes('assessPublishOwnershipState')
    && /After EVERY spawn outcome/i.test(libSrc)
    && libSrc.includes('ownFinal')
    && libSrc.includes('ownStaging'));
  red('lib_post_hook_exact_byte_reverify',
    libSrc.includes('verifyAnchoredExactOutputBytes')
    && /re-read fd-anchored exact output set/i.test(libSrc));
  ok('contract locks gnu mv no-replace publish',
    contract.output_safety
    && contract.output_safety.gnu_mv_no_replace_publish === true
    && contract.output_safety.node_rename_not_used_for_publish === true
    && contract.output_safety.sole_local_subprocess_gnu_mv === true
    && contract.output_safety.linux_gnu_disk_mode_boundary === true);
  ok('contract locks post-spawn ownership + byte reverify',
    contract.output_safety
    && contract.output_safety.publish_post_spawn_ownership_inspect_all_outcomes === true
    && contract.output_safety.publish_owned_final_removed_on_bad_spawn === true
    && contract.output_safety.publish_source_present_preserves_external_final === true
    && contract.output_safety.publish_impossible_state_no_unowned_delete === true
    && contract.output_safety.publish_post_hook_exact_output_byte_hash_reverify === true);
}

// ── Package script lock ─────────────────────────────────────────────────────
console.log('\n── Package script ──');
const pkg = readJson(path.join(ROOT, 'package.json'));
ok('package.json registers 1C verifier script',
  pkg.scripts
  && pkg.scripts[gen.PACKAGE_JSON_ALLOWED_SCRIPT_KEY] === gen.PACKAGE_JSON_ALLOWED_SCRIPT_VALUE);

// ── GREEN: independent golden truth + byte-determinism + materialization ───
console.log('\n── GREEN generation + independent golden truth ──');
const beforeTemplates = archetypeTemplateSnapshot();
const beforeClients = clientsTreeSnapshot();

for (const archetype of gen.ARCHETYPE_IDS) {
  const subs = loadSubs(archetype);
  let golden;
  try {
    golden = loadIndependentGolden(archetype, goldenLock);
    green(`${archetype}_golden_fixtures_load`, true);
  } catch (err) {
    green(`${archetype}_golden_fixtures_load`, false, err.message);
    continue;
  }

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
  green(`${archetype}_exact_output_set_vs_golden_lock`,
    gen.deepEqual(paths1, golden.lockedSet),
    `got=${paths1.join('|')} locked=${golden.lockedSet.join('|')}`);

  let goldenBytesMatch = paths1.length === golden.lockedSet.length;
  for (const f of r1.files) {
    const g = golden.diskFiles[f.relativePath];
    const locked = golden.entry.files[f.relativePath];
    if (!g || !locked) {
      goldenBytesMatch = false;
      break;
    }
    if (f.content !== g.text || f.sha256 !== g.hash || f.sha256 !== locked.sha256) {
      goldenBytesMatch = false;
      break;
    }
  }
  green(`${archetype}_generator_bytes_match_golden_fixtures`, goldenBytesMatch);

  const byteEqual = r1.files.every((f) => {
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

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `factory1c-${archetype}-parent-`));
  const finalDir = path.join(parent, 'final-out');
  const written = gen.writeDryRunPreview(r1, { repoRoot: ROOT, outputDir: finalDir });
  green(`${archetype}_atomic_write_ok`, written.ok, (written.errors || []).join(','));
  if (written.ok) {
    const onDisk = listFilesRecursive(finalDir)
      .map((abs) => path.relative(finalDir, abs).split(path.sep).join('/'))
      .sort();
    green(`${archetype}_disk_matches_golden_output_set`,
      gen.deepEqual(onDisk, golden.lockedSet));
    // Staging siblings must not remain.
    const leftovers = fs.readdirSync(parent).filter((n) => n.startsWith('.factory-1c-staging-'));
    green(`${archetype}_staging_cleaned_after_success`, leftovers.length === 0, leftovers.join(','));

    const overwrite = gen.writeDryRunPreview(r1, { repoRoot: ROOT, outputDir: finalDir });
    red(`${archetype}_final_must_not_exist_on_rewrite`,
      !overwrite.ok && overwrite.errors.includes('output_dir_must_not_exist'));
  }
}

const afterTemplates = archetypeTemplateSnapshot();
const afterClients = clientsTreeSnapshot();
green('template_immutability', gen.deepEqual(beforeTemplates, afterTemplates));
green('no_config_clients_side_effects', gen.deepEqual(beforeClients, afterClients));

// ── CLI dry-run + stdout zero-write ─────────────────────────────────────────
console.log('\n── CLI ──');
{
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-cli-parent-'));
  const out = path.join(parent, 'cli-out');
  const r = spawnSync(process.execPath, [
    CLI_PATH,
    '--archetype', 'surf_house',
    '--substitutions', path.join(FIXTURE_DIR, 'slice1c-substitutions-surf_house.json'),
    '--output-dir', out,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  green('cli_dry_run_exit_0', r.status === 0, (r.stderr || r.stdout || '').slice(-400));
  if (r.status === 0) {
    green('cli_wrote_manifest', fs.existsSync(path.join(out, 'dry-run-manifest.json')));
  }
  const apply = spawnSync(process.execPath, [
    CLI_PATH,
    '--apply',
    '--archetype', 'surf_house',
    '--substitutions', path.join(FIXTURE_DIR, 'slice1c-substitutions-surf_house.json'),
    '--output-dir', path.join(parent, 'apply-out'),
  ], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  red('cli_apply_rejected', apply.status !== 0
    && /apply_path_forbidden/.test(`${apply.stderr || ''}${apply.stdout || ''}`));
}

{
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-stdout-probe-'));
  const before = new Set(listFilesRecursive(probe).map((p) => path.relative(probe, p)));
  const cwdBefore = new Set(fs.readdirSync(ROOT));
  const r = spawnSync(process.execPath, [
    CLI_PATH,
    '--archetype', 'surf_house',
    '--substitutions', path.join(FIXTURE_DIR, 'slice1c-substitutions-surf_house.json'),
    '--stdout',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  green('cli_stdout_exit_0', r.status === 0, (r.stderr || '').slice(-300));
  green('cli_stdout_emits_json', r.status === 0 && /dry-run-manifest|fixture-house/.test(r.stdout || ''));
  const after = new Set(listFilesRecursive(probe).map((p) => path.relative(probe, p)));
  const cwdAfter = new Set(fs.readdirSync(ROOT));
  red('stdout_zero_write_probe_dir',
    [...after].every((p) => before.has(p)) && before.size === after.size);
  red('stdout_zero_write_repo_cwd',
    [...cwdAfter].every((p) => cwdBefore.has(p)) && cwdBefore.size === cwdAfter.size);
  // Library emitStdout also creates no files.
  const subs = loadSubs('surf_house');
  const preview = gen.generateDryRunPreview({
    repoRoot: ROOT,
    archetype: 'surf_house',
    mode: gen.MODE_DRY_RUN,
    substitutions: subs,
  });
  const emitted = gen.emitStdout(preview);
  green('emitStdout_ok', emitted.ok && typeof emitted.stdout === 'string');
  void probe;
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
  const unsafe = gen.validateOutputMaterializationTarget(
    ROOT,
    path.join(ROOT, 'config', 'clients', 'evil-out'),
  );
  red('unsafe_output_config_clients', !unsafe.ok
    && /forbidden_root:config\/clients/.test(unsafe.error));
}
{
  const unsafe = gen.validateOutputMaterializationTarget(
    ROOT,
    path.join(ROOT, 'config', 'archetypes', 'evil'),
  );
  red('unsafe_output_archetypes', !unsafe.ok
    && /forbidden_root:config\/archetypes/.test(unsafe.error));
}
{
  const unsafe = gen.validateOutputMaterializationTarget(ROOT, ROOT);
  red('unsafe_output_repo_root', !unsafe.ok && (
    unsafe.error === 'output_dir_cannot_be_repo_root'
    || unsafe.error === 'output_dir_must_not_exist'
  ));
}

// Output-safety REDs: symlinks, nested attacks, race/swap, staging cleanup
console.log('\n── Output-safety REDs ──');
{
  const preview = gen.generateDryRunPreview({
    repoRoot: ROOT,
    archetype: 'surf_house',
    mode: gen.MODE_DRY_RUN,
    substitutions: baseHouse,
  });
  ok('preview ok for output-safety suite', preview.ok, (preview.errors || []).join(','));

  // Symlinked parent
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-sym-parent-'));
    const realParent = path.join(base, 'real-parent');
    const linkParent = path.join(base, 'link-parent');
    fs.mkdirSync(realParent);
    fs.symlinkSync(realParent, linkParent);
    const target = path.join(linkParent, 'final');
    const v = gen.validateOutputMaterializationTarget(ROOT, target);
    red('reject_symlinked_parent', !v.ok && /parent_symlink|ancestor_symlink/.test(v.error),
      v.error);
    const w = gen.writeDryRunPreview(preview, { repoRoot: ROOT, outputDir: target });
    red('write_rejects_symlinked_parent', !w.ok
      && w.errors.some((e) => /parent_symlink|ancestor_symlink/.test(e)));
  }

  // Symlinked nested ancestor (parent is real; grandparent is symlink into forbidden)
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-sym-nested-'));
    const decoy = path.join(base, 'decoy');
    fs.mkdirSync(decoy);
    const linkAsAncestor = path.join(base, 'via-link');
    const forbidden = path.join(ROOT, 'config', 'clients');
    fs.symlinkSync(forbidden, linkAsAncestor);
    // Cannot create real directory under a symlink path that already is the symlink.
    // Instead: parent chain includes a symlink component via path.resolve through link.
    const nestedParent = path.join(linkAsAncestor, 'nested-parent');
    // mkdir through symlink would create inside config/clients — refuse to do that.
    // Validate a projected path whose parentAbs lstat is the symlink itself:
    const v = gen.validateOutputMaterializationTarget(
      ROOT,
      path.join(linkAsAncestor, 'evil-final'),
    );
    red('reject_symlinked_nested_ancestor_as_parent',
      !v.ok && (/parent_symlink|ancestor_symlink|forbidden_root/.test(v.error)),
      v.error);
    void decoy;
    void nestedParent;
  }

  // Symlinked output root (final exists as symlink)
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-sym-final-'));
    const realDir = path.join(base, 'real');
    fs.mkdirSync(realDir);
    const linkFinal = path.join(base, 'final-link');
    fs.symlinkSync(realDir, linkFinal);
    const v = gen.validateOutputMaterializationTarget(ROOT, linkFinal);
    red('reject_symlinked_output_root',
      !v.ok && (v.error === 'output_dir_symlink' || v.error === 'output_dir_must_not_exist'),
      v.error);
  }

  // Nested path-escape attack via relativePath (never traverse caller-controlled)
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-escape-'));
    const finalDir = path.join(base, 'final');
    const poisoned = {
      ok: true,
      errors: [],
      files: [
        {
          kind: 'baseline',
          relativePath: '../escape.json',
          content: '{"evil":true}\n',
          sha256: sha256Hex('{"evil":true}\n'),
        },
      ],
      manifest: {},
    };
    const w = gen.writeDryRunPreview(poisoned, { repoRoot: ROOT, outputDir: finalDir });
    red('reject_relative_path_traversal_nested',
      !w.ok && w.errors.some((e) => e.startsWith('write_path_traversal:')),
      (w.errors || []).join(','));
    red('staging_cleaned_after_traversal_reject',
      !fs.existsSync(finalDir)
      && fs.readdirSync(base).filter((n) => n.startsWith('.factory-1c-staging-')).length === 0);
  }

  // Race: final appears between staging write and atomic rename
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-race-'));
    const finalDir = path.join(base, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      beforeAtomicRename: ({ finalAbs }) => {
        fs.mkdirSync(finalAbs);
        fs.writeFileSync(path.join(finalAbs, 'hijack.txt'), 'race');
      },
    });
    red('race_final_appeared_fail_closed',
      !w.ok && w.errors.includes('output_dir_appeared'),
      (w.errors || []).join(','));
    // Staging must be cleaned; hijack dir may remain (attacker-created) — we must not
    // have renamed staging over it.
    const stagingLeft = fs.readdirSync(base).filter((n) => n.startsWith('.factory-1c-staging-'));
    red('race_staging_cleaned', stagingLeft.length === 0, stagingLeft.join(','));
    const hijackIntact = fs.existsSync(path.join(finalDir, 'hijack.txt'))
      && !fs.existsSync(path.join(finalDir, 'dry-run-manifest.json'));
    red('race_did_not_clobber_appeared_final', hijackIntact);
  }

  // Race: final appears as symlink before rename
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-race-sym-'));
    const finalDir = path.join(base, 'final');
    const decoy = path.join(base, 'decoy-target');
    fs.mkdirSync(decoy);
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      beforeAtomicRename: ({ finalAbs }) => {
        fs.symlinkSync(decoy, finalAbs);
      },
    });
    red('race_symlink_final_fail_closed',
      !w.ok && w.errors.some((e) => e === 'output_dir_appeared_symlink' || e === 'output_dir_appeared'),
      (w.errors || []).join(','));
    const stagingLeft = fs.readdirSync(base).filter((n) => n.startsWith('.factory-1c-staging-'));
    red('race_symlink_staging_cleaned', stagingLeft.length === 0, stagingLeft.join(','));
  }

  // Forbidden root via symlink parent pointing at config/clients
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-forbid-link-'));
    const linkParent = path.join(base, 'link-to-clients');
    fs.symlinkSync(path.join(ROOT, 'config', 'clients'), linkParent);
    const target = path.join(linkParent, 'evil-out');
    const v = gen.validateOutputMaterializationTarget(ROOT, target);
    red('reject_symlink_parent_into_forbidden',
      !v.ok && (/parent_symlink|ancestor_symlink|forbidden_root/.test(v.error)),
      v.error);
  }

  // Missing parent
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-missing-parent-'));
    const target = path.join(base, 'nope', 'final');
    const v = gen.validateOutputMaterializationTarget(ROOT, target);
    red('reject_missing_parent', !v.ok && v.error === 'output_dir_parent_missing', v.error);
  }

  function listFactory1cArtifacts(dirAbs) {
    if (!dirAbs || !fs.existsSync(dirAbs)) return [];
    let names;
    try {
      names = fs.readdirSync(dirAbs);
    } catch (_) {
      return [];
    }
    return names.filter((n) => (
      n.startsWith('.factory-1c-staging-')
      || n === 'final'
      || n === 'dry-run-manifest.json'
      || n === 'preview'
    ));
  }

  function dirHasFactory1cTree(dirAbs) {
    if (!dirAbs || !fs.existsSync(dirAbs)) return [];
    const found = [];
    const walk = (d) => {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const ent of entries) {
        if (ent.name.startsWith('.factory-1c-staging-')
          || ent.name === 'dry-run-manifest.json') {
          found.push(path.join(d, ent.name));
        }
        if (ent.isDirectory() && !ent.name.startsWith('.factory-1c-staging-')) {
          walk(path.join(d, ent.name));
        }
      }
    };
    walk(dirAbs);
    return found;
  }

  // RED: rename validated parent + replace with ordinary directory at same pathname.
  // Prove fail-closed and no staging/final under either original or replacement parent.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-parent-rename-'));
    const parent = path.join(base, 'validated-parent');
    const renamedParent = path.join(base, 'validated-parent.renamed-away');
    fs.mkdirSync(parent);
    const finalDir = path.join(parent, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      beforeAtomicRename: ({ parentPathname }) => {
        fs.renameSync(parentPathname, renamedParent);
        fs.mkdirSync(parentPathname); // replacement ordinary directory
      },
    });
    red('parent_rename_race_fail_closed',
      !w.ok && w.errors.some((e) => (
        e === 'parent_pathname_identity_mismatch'
        || e === 'parent_pathname_missing'
      )),
      (w.errors || []).join(','));
    const underReplacement = dirHasFactory1cTree(parent);
    const underOriginal = dirHasFactory1cTree(renamedParent);
    red('parent_rename_no_artifacts_under_replacement',
      underReplacement.length === 0, underReplacement.join(','));
    red('parent_rename_no_artifacts_under_original',
      underOriginal.length === 0, underOriginal.join(','));
    red('parent_rename_no_staging_or_final_either_parent',
      listFactory1cArtifacts(parent).length === 0
      && listFactory1cArtifacts(renamedParent).length === 0,
      `repl=${listFactory1cArtifacts(parent).join(',')} orig=${listFactory1cArtifacts(renamedParent).join(',')}`);
  }

  // Post-check: after successful publish, parent pathname swapped → fail closed + fd cleanup.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-post-swap-'));
    const parent = path.join(base, 'validated-parent');
    const renamedParent = path.join(base, 'validated-parent.post-renamed');
    fs.mkdirSync(parent);
    const finalDir = path.join(parent, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      afterAtomicRename: ({ parentPathname }) => {
        fs.renameSync(parentPathname, renamedParent);
        fs.mkdirSync(parentPathname);
      },
    });
    red('post_publish_parent_swap_fail_closed',
      !w.ok && w.errors.includes('parent_pathname_identity_mismatch'),
      (w.errors || []).join(','));
    const underReplacement = dirHasFactory1cTree(parent);
    const underOriginal = dirHasFactory1cTree(renamedParent);
    red('post_publish_swap_cleanup_no_artifacts_replacement',
      underReplacement.length === 0, underReplacement.join(','));
    red('post_publish_swap_cleanup_no_artifacts_original',
      underOriginal.length === 0, underOriginal.join(','));
  }

  // RED: empty final appears immediately before publish — Node rename would replace it;
  // GNU --no-clobber must leave it untouched with no preview published.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-empty-final-'));
    const parent = path.join(base, 'parent');
    fs.mkdirSync(parent);
    const finalDir = path.join(parent, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      beforeRenameAttempt: ({ finalAbs }) => {
        fs.mkdirSync(finalAbs); // empty preexisting final
      },
    });
    red('empty_final_race_fail_closed',
      !w.ok && w.errors.includes('gnu_mv_publish_source_remaining'),
      (w.errors || []).join(','));
    const stagingLeft = fs.readdirSync(parent).filter((n) => n.startsWith('.factory-1c-staging-'));
    red('empty_final_race_staging_cleaned_via_fd', stagingLeft.length === 0, stagingLeft.join(','));
    const emptyUntouched = fs.existsSync(finalDir)
      && fs.readdirSync(finalDir).length === 0
      && !fs.existsSync(path.join(finalDir, 'dry-run-manifest.json'))
      && !fs.existsSync(path.join(finalDir, 'preview'));
    red('empty_final_race_untouched_no_preview', emptyUntouched);
  }

  // Nonempty final injected after pre-checks → no-clobber leaves source; fail closed.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-nonempty-final-'));
    const parent = path.join(base, 'parent');
    fs.mkdirSync(parent);
    const finalDir = path.join(parent, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      beforeRenameAttempt: ({ finalAbs }) => {
        fs.mkdirSync(finalAbs);
        fs.writeFileSync(path.join(finalAbs, 'blocker.txt'), 'nope');
      },
    });
    red('nonempty_final_race_fail_closed',
      !w.ok && w.errors.includes('gnu_mv_publish_source_remaining'),
      (w.errors || []).join(','));
    const stagingLeft = fs.readdirSync(parent).filter((n) => n.startsWith('.factory-1c-staging-'));
    red('nonempty_final_race_staging_cleaned_via_fd', stagingLeft.length === 0, stagingLeft.join(','));
    const blockerIntact = fs.existsSync(path.join(finalDir, 'blocker.txt'))
      && !fs.existsSync(path.join(finalDir, 'dry-run-manifest.json'));
    red('nonempty_final_race_did_not_publish_preview', blockerIntact);
  }

  // Symlink final injected after pre-checks → no-clobber; fail closed; symlink preserved.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-symlink-race-'));
    const parent = path.join(base, 'parent');
    fs.mkdirSync(parent);
    const decoy = path.join(base, 'decoy');
    fs.mkdirSync(decoy);
    const finalDir = path.join(parent, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      beforeRenameAttempt: ({ finalAbs }) => {
        fs.symlinkSync(decoy, finalAbs);
      },
    });
    red('symlink_final_publish_race_fail_closed',
      !w.ok && w.errors.includes('gnu_mv_publish_source_remaining'),
      (w.errors || []).join(','));
    const stagingLeft = fs.readdirSync(parent).filter((n) => n.startsWith('.factory-1c-staging-'));
    red('symlink_final_publish_race_staging_cleaned', stagingLeft.length === 0, stagingLeft.join(','));
    red('symlink_final_publish_race_symlink_preserved',
      fs.lstatSync(finalDir).isSymbolicLink()
      && !fs.existsSync(path.join(decoy, 'dry-run-manifest.json')));
  }

  // Tool failure / spawn error path.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-tool-fail-'));
    const parent = path.join(base, 'parent');
    fs.mkdirSync(parent);
    const finalDir = path.join(parent, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      spawnPublish: () => ({ error: Object.assign(new Error('enoent'), { code: 'ENOENT' }) }),
    });
    red('publish_tool_failure_fail_closed',
      !w.ok && w.errors.some((e) => String(e).startsWith('gnu_mv_publish_spawn_error:')),
      (w.errors || []).join(','));
    const stagingLeft = fs.readdirSync(parent).filter((n) => n.startsWith('.factory-1c-staging-'));
    red('publish_tool_failure_staging_cleaned', stagingLeft.length === 0, stagingLeft.join(','));
    red('publish_tool_failure_no_final', !fs.existsSync(finalDir));
  }

  // Signal termination during publish.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-signal-'));
    const parent = path.join(base, 'parent');
    fs.mkdirSync(parent);
    const finalDir = path.join(parent, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      spawnPublish: () => ({ status: null, signal: 'SIGTERM', error: undefined }),
    });
    red('publish_signal_fail_closed',
      !w.ok && w.errors.includes('gnu_mv_publish_signal:SIGTERM'),
      (w.errors || []).join(','));
    const stagingLeft = fs.readdirSync(parent).filter((n) => n.startsWith('.factory-1c-staging-'));
    red('publish_signal_staging_cleaned', stagingLeft.length === 0, stagingLeft.join(','));
  }

  // Nonzero exit.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-nonzero-'));
    const parent = path.join(base, 'parent');
    fs.mkdirSync(parent);
    const finalDir = path.join(parent, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      spawnPublish: () => ({ status: 1, signal: null, error: undefined }),
    });
    red('publish_nonzero_fail_closed',
      !w.ok && w.errors.includes('gnu_mv_publish_nonzero:1'),
      (w.errors || []).join(','));
    const stagingLeft = fs.readdirSync(parent).filter((n) => n.startsWith('.factory-1c-staging-'));
    red('publish_nonzero_staging_cleaned', stagingLeft.length === 0, stagingLeft.join(','));
  }

  // Real move then mocked signal: ownership sees owned final → remove it and fail.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-real-signal-'));
    const parent = path.join(base, 'parent');
    fs.mkdirSync(parent);
    const finalDir = path.join(parent, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      spawnPublish: ({ file, args, spawnOpts }) => {
        spawnSync(file, args, spawnOpts); // real move completes
        return { status: null, signal: 'SIGTERM', error: undefined };
      },
    });
    red('publish_real_move_then_signal_fail_closed',
      !w.ok && w.errors.includes('gnu_mv_publish_signal:SIGTERM'),
      (w.errors || []).join(','));
    const stagingLeft = fs.readdirSync(parent).filter((n) => n.startsWith('.factory-1c-staging-'));
    red('publish_real_move_then_signal_owned_final_removed', !fs.existsSync(finalDir));
    red('publish_real_move_then_signal_staging_cleaned', stagingLeft.length === 0, stagingLeft.join(','));
  }

  // Real move then mocked nonzero: owned final removed.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-real-nonzero-'));
    const parent = path.join(base, 'parent');
    fs.mkdirSync(parent);
    const finalDir = path.join(parent, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      spawnPublish: ({ file, args, spawnOpts }) => {
        spawnSync(file, args, spawnOpts);
        return { status: 1, signal: null, error: undefined };
      },
    });
    red('publish_real_move_then_nonzero_fail_closed',
      !w.ok && w.errors.includes('gnu_mv_publish_nonzero:1'),
      (w.errors || []).join(','));
    const stagingLeft = fs.readdirSync(parent).filter((n) => n.startsWith('.factory-1c-staging-'));
    red('publish_real_move_then_nonzero_owned_final_removed', !fs.existsSync(finalDir));
    red('publish_real_move_then_nonzero_staging_cleaned', stagingLeft.length === 0, stagingLeft.join(','));
  }

  // Real move then mocked spawn error: owned final removed.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-real-error-'));
    const parent = path.join(base, 'parent');
    fs.mkdirSync(parent);
    const finalDir = path.join(parent, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      spawnPublish: ({ file, args, spawnOpts }) => {
        spawnSync(file, args, spawnOpts);
        return { error: Object.assign(new Error('eio'), { code: 'EIO' }) };
      },
    });
    red('publish_real_move_then_error_fail_closed',
      !w.ok && w.errors.some((e) => String(e).startsWith('gnu_mv_publish_spawn_error:')),
      (w.errors || []).join(','));
    const stagingLeft = fs.readdirSync(parent).filter((n) => n.startsWith('.factory-1c-staging-'));
    red('publish_real_move_then_error_owned_final_removed', !fs.existsSync(finalDir));
    red('publish_real_move_then_error_staging_cleaned', stagingLeft.length === 0, stagingLeft.join(','));
  }

  // Bad spawn with source still present + external final: clean staging, preserve final.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-signal-ext-'));
    const parent = path.join(base, 'parent');
    fs.mkdirSync(parent);
    const finalDir = path.join(parent, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      beforeRenameAttempt: ({ finalAbs }) => {
        fs.mkdirSync(finalAbs);
        fs.writeFileSync(path.join(finalAbs, 'external.txt'), 'keep-me');
      },
      spawnPublish: () => ({ status: null, signal: 'SIGKILL', error: undefined }),
    });
    red('publish_signal_external_final_fail_closed',
      !w.ok && w.errors.includes('gnu_mv_publish_signal:SIGKILL'),
      (w.errors || []).join(','));
    const stagingLeft = fs.readdirSync(parent).filter((n) => n.startsWith('.factory-1c-staging-'));
    red('publish_signal_external_final_staging_cleaned', stagingLeft.length === 0, stagingLeft.join(','));
    red('publish_signal_external_final_preserved',
      fs.existsSync(path.join(finalDir, 'external.txt'))
      && fs.readFileSync(path.join(finalDir, 'external.txt'), 'utf8') === 'keep-me'
      && !fs.existsSync(path.join(finalDir, 'dry-run-manifest.json')));
  }

  // Post-hook tamper: modify file bytes → fail + owned final removed.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-tamper-mod-'));
    const parent = path.join(base, 'parent');
    fs.mkdirSync(parent);
    const finalDir = path.join(parent, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      afterAtomicRename: ({ finalAbs }) => {
        fs.writeFileSync(`${finalAbs}/dry-run-manifest.json`, '{"tampered":true}\n');
      },
    });
    red('post_publish_tamper_modify_fail_closed',
      !w.ok && w.errors.some((e) => String(e).startsWith('gnu_mv_publish_content_mismatch:')),
      (w.errors || []).join(','));
    red('post_publish_tamper_modify_owned_final_removed', !fs.existsSync(finalDir));
    const stagingLeft = fs.readdirSync(parent).filter((n) => n.startsWith('.factory-1c-staging-'));
    red('post_publish_tamper_modify_staging_cleaned', stagingLeft.length === 0, stagingLeft.join(','));
  }

  // Post-hook tamper: delete a required file → fail + owned final removed.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-tamper-del-'));
    const parent = path.join(base, 'parent');
    fs.mkdirSync(parent);
    const finalDir = path.join(parent, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      afterAtomicRename: ({ finalAbs }) => {
        fs.unlinkSync(`${finalAbs}/dry-run-manifest.json`);
      },
    });
    red('post_publish_tamper_delete_fail_closed',
      !w.ok && w.errors.some((e) => String(e).startsWith('gnu_mv_publish_content_missing:')),
      (w.errors || []).join(','));
    red('post_publish_tamper_delete_owned_final_removed', !fs.existsSync(finalDir));
    const stagingLeft = fs.readdirSync(parent).filter((n) => n.startsWith('.factory-1c-staging-'));
    red('post_publish_tamper_delete_staging_cleaned', stagingLeft.length === 0, stagingLeft.join(','));
  }

  // Post-hook tamper: add unexpected file → fail + owned final removed.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-tamper-add-'));
    const parent = path.join(base, 'parent');
    fs.mkdirSync(parent);
    const finalDir = path.join(parent, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      afterAtomicRename: ({ finalAbs }) => {
        fs.writeFileSync(`${finalAbs}/extra-evil.txt`, 'nope');
      },
    });
    red('post_publish_tamper_add_fail_closed',
      !w.ok && w.errors.some((e) => String(e).startsWith('gnu_mv_publish_unexpected_path:')),
      (w.errors || []).join(','));
    red('post_publish_tamper_add_owned_final_removed', !fs.existsSync(finalDir));
    const stagingLeft = fs.readdirSync(parent).filter((n) => n.startsWith('.factory-1c-staging-'));
    red('post_publish_tamper_add_staging_cleaned', stagingLeft.length === 0, stagingLeft.join(','));
  }

  // Post-hook tamper: replace a file with a symlink → fail + owned final removed.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-tamper-sym-'));
    const parent = path.join(base, 'parent');
    fs.mkdirSync(parent);
    const decoy = path.join(base, 'decoy-manifest.json');
    fs.writeFileSync(decoy, '{"decoy":true}\n');
    const finalDir = path.join(parent, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      afterAtomicRename: ({ finalAbs }) => {
        fs.unlinkSync(`${finalAbs}/dry-run-manifest.json`);
        fs.symlinkSync(decoy, `${finalAbs}/dry-run-manifest.json`);
      },
    });
    red('post_publish_tamper_symlink_fail_closed',
      !w.ok && w.errors.some((e) => String(e).startsWith('gnu_mv_publish_content_is_symlink:')),
      (w.errors || []).join(','));
    red('post_publish_tamper_symlink_owned_final_removed', !fs.existsSync(finalDir));
    const stagingLeft = fs.readdirSync(parent).filter((n) => n.startsWith('.factory-1c-staging-'));
    red('post_publish_tamper_symlink_staging_cleaned', stagingLeft.length === 0, stagingLeft.join(','));
    red('post_publish_tamper_symlink_decoy_untouched',
      fs.existsSync(decoy) && fs.readFileSync(decoy, 'utf8') === '{"decoy":true}\n');
  }

  // Ambiguous state: exit 0 but source still present (no-clobber skip / lied success).
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-ambiguous-'));
    const parent = path.join(base, 'parent');
    fs.mkdirSync(parent);
    const finalDir = path.join(parent, 'final');
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      spawnPublish: () => ({ status: 0, signal: null, error: undefined }), // no-op
    });
    red('publish_ambiguous_source_remaining_fail_closed',
      !w.ok && w.errors.includes('gnu_mv_publish_source_remaining'),
      (w.errors || []).join(','));
    const stagingLeft = fs.readdirSync(parent).filter((n) => n.startsWith('.factory-1c-staging-'));
    red('publish_ambiguous_staging_cleaned', stagingLeft.length === 0, stagingLeft.join(','));
    red('publish_ambiguous_no_final_published', !fs.existsSync(finalDir));
  }

  // Argument-injection / spawn contract: fixed executable+flags, no shell, closed stdio,
  // fd-anchored paths only; metacharacters in leaf names stay literal argv elements.
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-argv-'));
    const parent = path.join(base, 'parent');
    fs.mkdirSync(parent);
    // No path separators — those would change dirname — but shell metacharacters remain.
    const evilName = 'final; id; echo PWNED$(whoami)`id`';
    const finalDir = path.join(parent, evilName);
    let observed = null;
    const w = gen.writeDryRunPreview(preview, {
      repoRoot: ROOT,
      outputDir: finalDir,
      observePublishSpawn: (obs) => { observed = obs; },
    });
    red('publish_argv_injection_path_succeeds_literally', w.ok, (w.errors || []).join(','));
    red('publish_argv_exact_executable',
      observed && observed.file === gen.GNU_MV_PATH, observed && observed.file);
    red('publish_argv_exact_flags_prefix',
      observed
      && gen.deepEqual(observed.args.slice(0, gen.GNU_MV_PUBLISH_ARGS.length), [...gen.GNU_MV_PUBLISH_ARGS]),
      observed && JSON.stringify(observed.args));
    red('publish_argv_no_shell',
      observed && observed.spawnOpts.shell === false);
    red('publish_argv_stdio_closed',
      observed
      && gen.deepEqual(observed.spawnOpts.stdio, ['ignore', 'ignore', 'ignore']));
    red('publish_argv_paths_fd_anchored',
      observed
      && observed.args.length === gen.GNU_MV_PUBLISH_ARGS.length + 2
      && observed.args.every((a, i) => (
        i < gen.GNU_MV_PUBLISH_ARGS.length
        || /^\/proc\/\d+\/fd\/\d+\//.test(String(a))
      )));
    red('publish_argv_leaf_metacharacters_literal',
      observed && observed.args[observed.args.length - 1].endsWith(`/${evilName}`));
    red('publish_argv_no_shell_side_effects_in_parent',
      !fs.existsSync(path.join(parent, 'PWNED'))
      && fs.readdirSync(parent).filter((n) => n !== evilName).length === 0);
  }
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
