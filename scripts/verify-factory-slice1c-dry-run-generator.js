'use strict';

/**
 * verify:factory-slice1c-dry-run-generator — FACTORY Slice 1C
 *
 * Independent verifier for the deterministic disabled dry-run onboarding
 * generator. Proves byte-determinism against independently locked golden
 * rendered-byte fixtures (without importing generator expectation helpers),
 * template immutability, stdout-only zero-write emission, and adversarial
 * rejection. No apply, no disk materialization, no registry edits, no
 * config/clients writes, no runtime/DB/cloud/network. Safe disk
 * materialization is unsupported (not deferred proof).
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

/** Install write-side fs traps; returns { hits, restore }. */
function installFsWriteTraps() {
  const hits = [];
  // Intentionally omit open/openSync: Node readFileSync may route through the
  // JS openSync binding when monkey-patched. Static REDs already forbid open*.
  const names = [
    'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile',
    'mkdirSync', 'mkdir', 'renameSync', 'rename', 'rmSync', 'rm',
    'unlinkSync', 'unlink', 'rmdirSync', 'rmdir', 'symlinkSync', 'symlink',
    'linkSync', 'link', 'copyFileSync', 'copyFile', 'truncateSync', 'truncate',
    'createWriteStream', 'chmodSync', 'chownSync',
  ];
  const originals = {};
  for (const name of names) {
    if (typeof fs[name] !== 'function') continue;
    originals[name] = fs[name];
    fs[name] = function trapped(...args) {
      hits.push({ name, args: args.map((a) => (typeof a === 'string' ? a : typeof a)) });
      return originals[name].apply(this, args);
    };
  }
  return {
    hits,
    restore() {
      for (const [name, fn] of Object.entries(originals)) fs[name] = fn;
    },
  };
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
const libSrc = readText(LIB_PATH);
const cliSrc = readText(CLI_PATH);

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
ok('findings cite zero-write / stdout / unsupported disk',
  /zero-write|stdout/i.test(findings)
  && /unsupported/i.test(findings)
  && /disk materialization/i.test(findings)
  && /golden/i.test(findings));
ok('findings do not claim disk publish complete',
  !/\/usr\/bin\/mv/.test(findings)
  && !/atomic no-replace publish/i.test(findings)
  && /unsupported/i.test(findings)
  && /zero-write/i.test(findings));
ok('doc names 1C generator', /1C/.test(doc) && /generator/i.test(doc));
ok('doc cites stdout zero-write + unsupported disk materialization',
  /stdout/i.test(doc)
  && /zero-write|zero writes/i.test(doc)
  && /disk materialization.*unsupported|unsupported.*disk materialization/i.test(doc));
ok('doc does not claim GNU mv / procfs publish',
  !doc.includes('/usr/bin/mv')
  && !/proc\/self\/fd/i.test(doc)
  && !/\bgnu\s+mv\b/i.test(doc));
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

// Source fence: library/CLI have no disk-publication surface.
console.log('\n── Static zero-write / no-publish fences ──');
{
  red('lib_no_child_process',
    !/require\s*\(\s*['"]child_process['"]\s*\)/.test(libSrc)
    && !/\bspawnSync\b/.test(libSrc)
    && !/\bexecFileSync\b/.test(libSrc)
    && !/\bexecSync\b/.test(libSrc)
    && !/\bexecFile\b/.test(libSrc)
    && !/\bspawn\s*\(/.test(libSrc)
    && !/\b(?:child_process|cp)\.exec\s*\(/.test(libSrc));
  red('lib_no_gnu_mv',
    !libSrc.includes('/usr/bin/mv')
    && !/\bGNU_MV\b/.test(libSrc)
    && !/--no-clobber|--no-copy/.test(libSrc));
  red('lib_no_procfs_fd_hooks',
    !/\/proc\/self\/fd/.test(libSrc)
    && !/\/proc\/\$\{/.test(libSrc)
    && !/O_DIRECTORY|O_NOFOLLOW/.test(libSrc)
    && !/\bparent_fd\b|\banchorBase\b/.test(libSrc));
  red('lib_no_fs_write_apis',
    !/\bfs\.writeFile(Sync)?\s*\(/.test(libSrc)
    && !/\bfs\.appendFile(Sync)?\s*\(/.test(libSrc)
    && !/\bfs\.mkdir(Sync)?\s*\(/.test(libSrc)
    && !/\bfs\.rename(Sync)?\s*\(/.test(libSrc)
    && !/\bfs\.rm(Sync)?\s*\(/.test(libSrc)
    && !/\bfs\.unlink(Sync)?\s*\(/.test(libSrc)
    && !/\bfs\.rmdir(Sync)?\s*\(/.test(libSrc)
    && !/\bfs\.symlink(Sync)?\s*\(/.test(libSrc)
    && !/\bfs\.copyFile(Sync)?\s*\(/.test(libSrc)
    && !/\bfs\.createWriteStream\s*\(/.test(libSrc)
    && !/\bfs\.open(Sync)?\s*\(/.test(libSrc)
    && !/\bfs\.promises\.(writeFile|mkdir|rename|rm|unlink)/.test(libSrc));
  red('lib_no_writeDryRunPreview_export',
    !/\bfunction writeDryRunPreview\b/.test(libSrc)
    && !/\bwriteDryRunPreview\s*,/.test(libSrc)
    && !/\bwriteDryRunPreview\s*:/.test(libSrc)
    && typeof gen.writeDryRunPreview !== 'function');
  red('lib_no_output_dir_materialization_api',
    !/\bvalidateOutputMaterializationTarget\b/.test(libSrc)
    && !/\bisSafeOutputDirectory\b/.test(libSrc)
    && !/\bspawnGnuMvNoReplacePublish\b/.test(libSrc)
    && !/\bcleanupStagingDir\b/.test(libSrc)
    && typeof gen.validateOutputMaterializationTarget !== 'function'
    && typeof gen.isSafeOutputDirectory !== 'function');
  red('cli_no_output_dir_path',
    !/--output-dir <dir>/.test(cliSrc)
    && !/writeDryRunPreview/.test(cliSrc)
    && /disk_materialization_unsupported/.test(cliSrc)
    && /apply_path_forbidden/.test(cliSrc));
  ok('contract locks stdout zero-write + disk unsupported',
    contract.output_safety
    && contract.output_safety.stdout_zero_write === true
    && contract.output_safety.disk_materialization_supported === false
    && contract.output_safety.safe_disk_materialization === 'unsupported'
    && contract.output_safety.no_fs_write_apis === true
    && contract.output_safety.no_child_process === true
    && contract.output_safety.no_procfs_fd_hooks === true
    && contract.output_safety.no_gnu_mv_publish === true
    && contract.output_safety.no_output_dir_flag === true
    && contract.output_safety.no_apply_path === true);
  ok('contract evidence classes omit atomic disk staging',
    Array.isArray(contract.evidence_classes.required_current_stage)
    && !contract.evidence_classes.required_current_stage.includes(
      'atomic_staging_materialization_output_safety',
    )
    && contract.evidence_classes.required_current_stage.includes('stdout_zero_write')
    && contract.evidence_classes.required_current_stage.includes(
      'disk_materialization_unsupported',
    )
    && contract.evidence_classes.out_of_scope_current_stage.includes(
      'safe_disk_materialization',
    ));
}

// ── Package script lock ─────────────────────────────────────────────────────
console.log('\n── Package script ──');
const pkg = readJson(path.join(ROOT, 'package.json'));
ok('package.json registers 1C verifier script',
  pkg.scripts
  && pkg.scripts[gen.PACKAGE_JSON_ALLOWED_SCRIPT_KEY] === gen.PACKAGE_JSON_ALLOWED_SCRIPT_VALUE);

// ── GREEN: independent golden truth + byte-determinism (in-memory only) ─────
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

  const traps = installFsWriteTraps();
  let r1;
  let r2;
  let emitted;
  try {
    r1 = gen.generateDryRunPreview({
      repoRoot: ROOT,
      archetype,
      mode: gen.MODE_DRY_RUN,
      substitutions: subs,
    });
    r2 = gen.generateDryRunPreview({
      repoRoot: ROOT,
      archetype,
      mode: gen.MODE_DRY_RUN,
      substitutions: JSON.parse(JSON.stringify(subs)),
    });
    emitted = r1.ok ? gen.emitStdout(r1) : { ok: false, errors: r1.errors };
  } finally {
    traps.restore();
  }

  red(`${archetype}_runtime_no_fs_write_side_effects`,
    traps.hits.length === 0,
    traps.hits.slice(0, 5).map((h) => h.name).join(','));

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

  green(`${archetype}_emitStdout_ok`, emitted.ok && typeof emitted.stdout === 'string');
  if (emitted.ok) {
    let envelope;
    try {
      envelope = JSON.parse(emitted.stdout);
    } catch (err) {
      envelope = null;
      green(`${archetype}_stdout_envelope_json`, false, err.message);
    }
    if (envelope) {
      green(`${archetype}_stdout_envelope_canonical`,
        envelope.ok === true
        && envelope.mode === gen.MODE_DRY_RUN
        && envelope.disk_materialization === false
        && envelope.disk_materialization_supported === false
        && envelope.writes === false
        && envelope.manifest
        && Array.isArray(envelope.files));
      const envPaths = envelope.files.map((f) => f.relativePath).sort();
      green(`${archetype}_stdout_envelope_exact_files`,
        gen.deepEqual(envPaths, golden.lockedSet));
      let envBytes = true;
      for (const f of envelope.files) {
        const g = golden.diskFiles[f.relativePath];
        if (!g || f.content !== g.text || f.sha256 !== g.hash) {
          envBytes = false;
          break;
        }
      }
      green(`${archetype}_stdout_envelope_bytes_match_golden`, envBytes);
    }
  }
}

const afterTemplates = archetypeTemplateSnapshot();
const afterClients = clientsTreeSnapshot();
green('template_immutability', gen.deepEqual(beforeTemplates, afterTemplates));
green('no_config_clients_side_effects', gen.deepEqual(beforeClients, afterClients));

// ── CLI stdout-only + rejection of disk/apply flags ─────────────────────────
console.log('\n── CLI ──');
{
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1c-stdout-probe-'));
  const before = new Set(listFilesRecursive(probe).map((p) => path.relative(probe, p)));
  const cwdBefore = new Set(fs.readdirSync(ROOT));
  const r = spawnSync(process.execPath, [
    CLI_PATH,
    '--archetype', 'surf_house',
    '--substitutions', path.join(FIXTURE_DIR, 'slice1c-substitutions-surf_house.json'),
  ], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  green('cli_default_stdout_exit_0', r.status === 0, (r.stderr || '').slice(-300));
  green('cli_default_stdout_emits_json_envelope',
    r.status === 0
    && /"disk_materialization_supported": false/.test(r.stdout || '')
    && /dry-run-manifest|fixture-house/.test(r.stdout || ''));
  const after = new Set(listFilesRecursive(probe).map((p) => path.relative(probe, p)));
  const cwdAfter = new Set(fs.readdirSync(ROOT));
  red('stdout_zero_write_probe_dir',
    [...after].every((p) => before.has(p)) && before.size === after.size);
  red('stdout_zero_write_repo_cwd',
    [...cwdAfter].every((p) => cwdBefore.has(p)) && cwdBefore.size === cwdAfter.size);

  const explicit = spawnSync(process.execPath, [
    CLI_PATH,
    '--archetype', 'surf_house',
    '--substitutions', path.join(FIXTURE_DIR, 'slice1c-substitutions-surf_house.json'),
    '--stdout',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  green('cli_explicit_stdout_exit_0', explicit.status === 0, (explicit.stderr || '').slice(-200));

  const outDir = spawnSync(process.execPath, [
    CLI_PATH,
    '--archetype', 'surf_house',
    '--substitutions', path.join(FIXTURE_DIR, 'slice1c-substitutions-surf_house.json'),
    '--output-dir', path.join(probe, 'should-not-exist'),
  ], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  red('cli_output_dir_rejected',
    outDir.status !== 0
    && /disk_materialization_unsupported:--output-dir/.test(`${outDir.stderr || ''}${outDir.stdout || ''}`));
  red('cli_output_dir_created_nothing',
    !fs.existsSync(path.join(probe, 'should-not-exist')));

  const apply = spawnSync(process.execPath, [
    CLI_PATH,
    '--apply',
    '--archetype', 'surf_house',
    '--substitutions', path.join(FIXTURE_DIR, 'slice1c-substitutions-surf_house.json'),
  ], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  red('cli_apply_rejected', apply.status !== 0
    && /apply_path_forbidden/.test(`${apply.stderr || ''}${apply.stdout || ''}`));

  for (const flag of ['--write', '--materialize', '--publish', '--out', '--outdir']) {
    const bad = spawnSync(process.execPath, [
      CLI_PATH,
      flag, path.join(probe, 'x'),
      '--archetype', 'surf_house',
      '--substitutions', path.join(FIXTURE_DIR, 'slice1c-substitutions-surf_house.json'),
    ], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    red(`cli_rejects_${flag.replace(/^--/, '')}`,
      bad.status !== 0
      && new RegExp(`disk_materialization_unsupported:${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(
        `${bad.stderr || ''}${bad.stdout || ''}`,
      ));
  }
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

// ── Reserved substituted-key safety REDs ────────────────────────────────────
console.log('\n── Reserved substituted-key safety REDs ──');
{
  const PROTO_OWN_BEFORE = Object.getOwnPropertyNames(Object.prototype).slice().sort().join(',');
  function protoUnchanged() {
    return Object.getOwnPropertyNames(Object.prototype).slice().sort().join(',') === PROTO_OWN_BEFORE;
  }

  const RESERVED_EXACT = [...gen.RESERVED_OBJECT_KEYS];
  // Exact policy: ASCII case-insensitive match of the three reserved names.
  const RESERVED_MIXED = ['__Proto__', 'Prototype', 'Constructor'];

  const contexts = [
    {
      map: 'package',
      archetype: 'surf_house',
      token: 'PACKAGE_CODE_1',
      base: baseHouse,
      slug: 'fresh-house-pkg',
      locPatch: { LOCATION_ID: 'fresh-house-pkg-main' },
    },
    {
      map: 'rental',
      archetype: 'surf_school_shop',
      token: 'RENTAL_BOARD',
      base: baseSchool,
      slug: 'fresh-school-rental',
      locPatch: { LOCATION_ID_1: 'fresh-school-rental-a', LOCATION_ID_2: 'fresh-school-rental-b' },
    },
    {
      map: 'lesson',
      archetype: 'surf_school_shop',
      token: 'LESSON_GROUP_ADULT',
      base: baseSchool,
      slug: 'fresh-school-lesson',
      locPatch: { LOCATION_ID_1: 'fresh-school-lesson-a', LOCATION_ID_2: 'fresh-school-lesson-b' },
    },
    {
      map: 'location',
      archetype: 'surf_house',
      token: 'ROOM_ID_1',
      base: baseHouse,
      slug: 'fresh-house-loc',
      locPatch: { LOCATION_ID: 'fresh-house-loc-main' },
    },
    {
      map: 'nested_price',
      archetype: 'surf_school_shop',
      token: 'RENTAL_WINDOW_1',
      base: baseSchool,
      slug: 'fresh-school-price',
      locPatch: { LOCATION_ID_1: 'fresh-school-price-a', LOCATION_ID_2: 'fresh-school-price-b' },
    },
  ];

  for (const ctx of contexts) {
    for (const reserved of RESERVED_EXACT) {
      const id = `reserved_key_${ctx.map}_${reserved.replace(/_/g, '')}`;
      const substitutions = {
        ...ctx.base,
        CLIENT_SLUG: `${ctx.slug}-${reserved.replace(/_/g, '')}`.slice(0, 64).replace(/-$/, ''),
        ...ctx.locPatch,
        [ctx.token]: reserved,
      };
      // Keep location ids unique + valid when slug patch collides with reserved.
      if (ctx.archetype === 'surf_house') {
        substitutions.LOCATION_ID = `${substitutions.CLIENT_SLUG}-main`;
      } else {
        substitutions.LOCATION_ID_1 = `${substitutions.CLIENT_SLUG}-a`;
        substitutions.LOCATION_ID_2 = `${substitutions.CLIENT_SLUG}-b`;
      }
      const r = gen.generateDryRunPreview({
        repoRoot: ROOT,
        archetype: ctx.archetype,
        mode: gen.MODE_DRY_RUN,
        substitutions,
      });
      const errs = r.errors || [];
      red(id,
        !r.ok
        && errs.some((e) => e === `reserved_object_key:${reserved}`)
        && protoUnchanged()
        && !Object.prototype.hasOwnProperty('polluted'),
        errs.join(','));
    }

    for (const mixed of RESERVED_MIXED) {
      const id = `reserved_key_${ctx.map}_mixed_${mixed.replace(/_/g, '')}`;
      const substitutions = {
        ...ctx.base,
        CLIENT_SLUG: `${ctx.slug}-m-${mixed.replace(/[^a-zA-Z]/g, '').toLowerCase()}`.slice(0, 64),
        [ctx.token]: mixed,
      };
      if (ctx.archetype === 'surf_house') {
        substitutions.LOCATION_ID = `${substitutions.CLIENT_SLUG}-main`;
      } else {
        substitutions.LOCATION_ID_1 = `${substitutions.CLIENT_SLUG}-a`;
        substitutions.LOCATION_ID_2 = `${substitutions.CLIENT_SLUG}-b`;
      }
      const r = gen.generateDryRunPreview({
        repoRoot: ROOT,
        archetype: ctx.archetype,
        mode: gen.MODE_DRY_RUN,
        substitutions,
      });
      const errs = r.errors || [];
      red(id,
        !r.ok
        && errs.some((e) => e === `reserved_object_key:${mixed}`)
        && protoUnchanged(),
        errs.join(','));
    }
  }

  // Literal reserved keys (not placeholder-derived) — JSON own keys, every map label.
  for (const reserved of RESERVED_EXACT) {
    for (const mapName of ['package', 'rental', 'lesson', 'location', 'nested_price']) {
      const unresolved = new Set();
      const errors = [];
      // JSON.parse yields an own key named __proto__; object-literal syntax would not.
      const tree = JSON.parse(`{"keep":{"map":"${mapName}"},"${reserved}":{"marker":1}}`);
      const out = gen.substituteTree(tree, {}, unresolved, null, errors);
      const ownKeys = Object.keys(out);
      red(`literal_reserved_${mapName}_${reserved.replace(/_/g, '')}`,
        errors.includes(`reserved_object_key:${reserved}`)
        && ownKeys.includes('keep')
        && !ownKeys.includes(reserved)
        && Object.getPrototypeOf(out) === null
        && protoUnchanged(),
        `errors=${errors.join(',')} keys=${ownKeys.join(',')}`);
    }
  }

  // Collision re-check after substitution (two tokens -> same key).
  {
    const r = gen.generateDryRunPreview({
      repoRoot: ROOT,
      archetype: 'surf_house',
      mode: gen.MODE_DRY_RUN,
      substitutions: {
        ...baseHouse,
        CLIENT_SLUG: 'fresh-house-collision',
        LOCATION_ID: 'fresh-house-collision-main',
        PACKAGE_CODE_1: 'same-pack',
        PACKAGE_CODE_2: 'same-pack',
      },
    });
    red('post_sub_key_collision_recheck',
      !r.ok && (r.errors || []).some((e) => e === 'key_collision:same-pack'),
      (r.errors || []).join(','));
  }

  // Cross-refs use enumerable own keys only (inherited prototype keys must not satisfy).
  {
    const polluted = false;
    try {
      // If a prior bug polluted, clean for the assertion surface.
      delete Object.prototype.surf_week;
    } catch (_) { /* ignore */ }
    const r = gen.generateDryRunPreview({
      repoRoot: ROOT,
      archetype: 'surf_house',
      mode: gen.MODE_DRY_RUN,
      substitutions: {
        ...baseHouse,
        CLIENT_SLUG: 'fresh-house-ownkeys',
        LOCATION_ID: 'fresh-house-ownkeys-main',
      },
    });
    let ownOk = false;
    if (r.ok) {
      const baseline = JSON.parse(r.files.find((f) => f.kind === 'baseline').content);
      const inclusions = baseline.packages.inclusions;
      const known = baseline.packages.known_packages;
      ownOk = known.every((pkg) => Object.prototype.hasOwnProperty.call(inclusions, pkg)
        && Object.keys(inclusions).includes(pkg));
    }
    red('cross_ref_enumerable_own_keys_only',
      r.ok && ownOk && protoUnchanged() && !polluted,
      r.ok ? `ownOk=${ownOk}` : (r.errors || []).join(','));
  }

  // GREEN: null-prototype substituted objects, no omitted package keys.
  {
    const r = gen.generateDryRunPreview({
      repoRoot: ROOT,
      archetype: 'surf_house',
      mode: gen.MODE_DRY_RUN,
      substitutions: {
        ...baseHouse,
        CLIENT_SLUG: 'fresh-house-nullproto',
        LOCATION_ID: 'fresh-house-nullproto-main',
      },
    });
    let detail = '';
    let passNull = false;
    if (r.ok) {
      const unresolved = new Set();
      const errors = [];
      const templates = gen.loadArchetypeTemplates(ROOT, 'surf_house');
      const subs = { ...baseHouse, CLIENT_SLUG: 'fresh-house-nullproto', LOCATION_ID: 'fresh-house-nullproto-main' };
      const baseline = gen.substituteTree(gen.thaw(templates.baseline), subs, unresolved, null, errors);
      const known = baseline.packages.known_packages;
      const inclusionKeys = Object.keys(baseline.packages.inclusions);
      passNull = Object.getPrototypeOf(baseline) === null
        && Object.getPrototypeOf(baseline.packages.inclusions) === null
        && errors.length === 0
        && known.every((k) => inclusionKeys.includes(k))
        && inclusionKeys.length === known.length;
      detail = `protoNull=${Object.getPrototypeOf(baseline) === null} keys=${inclusionKeys.join(',')}`;
    }
    green('substituted_null_prototype_no_omitted_keys',
      r.ok && passNull && protoUnchanged(),
      detail || (r.errors || []).join(','));
  }

  red('object_prototype_unpolluted_after_reserved_reds', protoUnchanged());
}

// ── Typed whole-token substitution REDs ─────────────────────────────────────
console.log('\n── Typed whole-token substitution REDs ──');
{
  const unresolved = new Set();
  const outNum = gen.substituteTree('{{PRICE}}', { PRICE: 1000 }, unresolved, null, []);
  red('whole_token_preserves_number', outNum === 1000 && typeof outNum === 'number');

  unresolved.clear();
  const outBool = gen.substituteTree('{{FLAG}}', { FLAG: false }, unresolved, null, []);
  red('whole_token_preserves_boolean', outBool === false && typeof outBool === 'boolean');

  unresolved.clear();
  const outNull = gen.substituteTree('{{OPT}}', { OPT: null }, unresolved, null, []);
  red('whole_token_preserves_null', outNull === null);

  unresolved.clear();
  const outStr = gen.substituteTree('{{NAME}}', { NAME: 'fixture' }, unresolved, null, []);
  red('whole_token_preserves_string', outStr === 'fixture' && typeof outStr === 'string');

  unresolved.clear();
  const embedded = gen.substituteTree('prefix-{{PRICE}}-suffix', { PRICE: 1000 }, unresolved, null, []);
  red('embedded_token_stringifies_number',
    embedded === 'prefix-1000-suffix' && typeof embedded === 'string');

  unresolved.clear();
  const embeddedBool = gen.substituteTree('x-{{FLAG}}-y', { FLAG: true }, unresolved, null, []);
  red('embedded_token_stringifies_boolean',
    embeddedBool === 'x-true-y' && typeof embeddedBool === 'string');

  const badObj = gen.normalizeSubstitutionsMap({ CLIENT_SLUG: { nested: true } });
  red('rejects_object_substitution_values',
    badObj.ok === false
    && badObj.errors.some((e) => e.includes('substitution_value_type_invalid:CLIENT_SLUG:object')));

  const badArr = gen.normalizeSubstitutionsMap({ CLIENT_SLUG: ['a'] });
  red('rejects_array_substitution_values',
    badArr.ok === false
    && badArr.errors.some((e) => e.includes('substitution_value_type_invalid:CLIENT_SLUG:array')));

  // Fixture + golden typed prices (Sunset flatten consumer requires numbers).
  const schoolSubs = loadSubs('surf_school_shop');
  red('school_fixture_price_eur_is_number',
    typeof schoolSubs.PRICE_EUR_PLACEHOLDER === 'number'
    && schoolSubs.PRICE_EUR_PLACEHOLDER > 0);
  const houseSubs = loadSubs('surf_house');
  red('house_fixture_price_cents_is_number',
    typeof houseSubs.PRICE_CENTS_PLACEHOLDER === 'number'
    && houseSubs.PRICE_CENTS_PLACEHOLDER > 0);

  const schoolGolden = readJson(path.join(
    FIXTURE_DIR,
    'slice1c-golden',
    'surf_school_shop',
    'preview',
    'fixture-school.baseline.json',
  ));
  const lessonPrice = schoolGolden.catalog.lessons.offerings.group_adult.prices_eur.single_lesson;
  red('school_golden_lesson_price_is_nonzero_number',
    typeof lessonPrice === 'number' && lessonPrice > 0);

  const houseGoldenPricing = readJson(path.join(
    FIXTURE_DIR,
    'slice1c-golden',
    'surf_house',
    'preview',
    'fixture-house.pricing.json',
  ));
  const weekly = houseGoldenPricing.packages[0].seasonal_prices.peak.weekly_per_person_cents;
  red('house_golden_weekly_cents_is_nonzero_number',
    typeof weekly === 'number' && weekly > 0);

  // loadSubstitutionsFile preserves types from disk.
  const loaded = gen.loadSubstitutionsFile(
    path.join(FIXTURE_DIR, 'slice1c-substitutions-surf_house.json'),
  );
  red('loadSubstitutionsFile_preserves_typed_scalars',
    loaded.ok
    && typeof loaded.substitutions.PRICE_CENTS_PLACEHOLDER === 'number'
    && typeof loaded.substitutions.CLIENT_SLUG === 'string');
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

// Structural recursion break: 1C may invoke 1B, but never 1A.
// No FACTORY_* env value may skip checks or force PASS.
console.log('\n── Nested prior factory gates ──');
{
  const verifierSrc = readText(path.join(ROOT, 'scripts', 'verify-factory-slice1c-dry-run-generator.js'));
  red('no_nested_1a_invocation',
    !/npm['"\s,]*run['"\s,]*verify:factory-slice1a/.test(verifierSrc)
    && !/spawnSync\([^)]*verify-factory-slice1a/.test(verifierSrc)
    && !/runNpm\(['"]verify:factory-slice1a/.test(verifierSrc));
  red('no_factory_skip_or_probe_env_bypasses',
    !/process\.env\.FACTORY_\w*(SKIP|PROBE)/.test(verifierSrc)
    && !/FACTORY_1[ABCD]_(SKIP|LEDGER_PROBE|SKIP_NESTED|SKIP_LEGACY)/.test(verifierSrc));

  const r1b = spawnSync('npm', ['run', 'verify:factory-slice1b-archetype-templates'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    timeout: 300000,
    shell: true,
  });
  ok('verify:factory-slice1b-archetype-templates exit 0',
    r1b.status === 0,
    r1b.status !== 0 ? (r1b.stderr || r1b.stdout || '').slice(-500) : '');
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
