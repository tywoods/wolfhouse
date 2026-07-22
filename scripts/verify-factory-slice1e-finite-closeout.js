'use strict';

/**
 * verify:factory-slice1e-finite-closeout — FACTORY Slice 1E
 *
 * Independent dry-run packaging + milestone closeout gate.
 * - Regenerates synthetic third-tenant stdout in a fresh process
 * - Compares exact committed artifact bytes + manifest/file hashes
 * - Proves no side effects on config/clients, registries, archetypes
 * - Runs 1A–1D + full Luna + hard multiclient gates
 * - Marks five stages / nine gates complete only after proof
 *
 * Docs/fixtures/verifier only — no product/runtime/template/generator changes.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');

const slice1e = require('./lib/factory-slice1e-finite-closeout');
const slice1a = require('./lib/factory-slice1a-acceptance-contract');
const slice1b = require('./lib/factory-slice1b-archetype-templates');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'factory-client-productization');
const CONTRACT_PATH = path.join(ROOT, slice1e.CONTRACT_REL);
const FINDINGS_PATH = path.join(ROOT, slice1e.FINDINGS_REL);
const HANDOFF_PATH = path.join(ROOT, slice1e.HANDOFF_REL);
const ARTIFACT_LOCK_PATH = path.join(ROOT, slice1e.ARTIFACT_LOCK_REL);
const STDOUT_PATH = path.join(ROOT, slice1e.STDOUT_ARTIFACT_REL);
const SUBS_PATH = path.join(ROOT, slice1e.SUBSTITUTIONS_REL);
const DOC_PATH = path.join(ROOT, 'docs', 'FACTORY-CLIENT-PRODUCTIZATION.md');
const CLI_PATH = path.join(ROOT, 'scripts', 'onboard-client.js');
const SLICE1A_CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice1a-contract.json');

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

function readBuf(p) {
  return fs.readFileSync(p);
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function tipPathsAllowed(changedPaths) {
  const prefixes = slice1e.ALLOWED_TIP_PATH_PREFIXES;
  const bad = [];
  for (const p of changedPaths) {
    const okPath = prefixes.some((pref) => (
      pref.endsWith('/') ? p.startsWith(pref) || p === pref.slice(0, -1) : p === pref
    ));
    if (!okPath) bad.push(p);
  }
  return { ok: bad.length === 0, bad };
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

function registrySnapshot() {
  const paths = [
    'config/clients/clients.json',
    'config/staff-portal-access.json',
  ];
  const snap = {};
  for (const rel of paths) {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs)) snap[rel] = sha256Hex(fs.readFileSync(abs));
  }
  return snap;
}

function archetypeTemplateSnapshot() {
  const snap = {};
  for (const id of ['surf_house', 'surf_school_shop']) {
    const dir = path.join(ROOT, 'config', 'archetypes', id);
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const rel = `config/archetypes/${id}/${name}`;
      snap[rel] = sha256Hex(fs.readFileSync(path.join(ROOT, rel)));
    }
  }
  return snap;
}

function installFsWriteTraps() {
  const hits = [];
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

function runCliFresh(absSubsPath, perturbation) {
  const baseEnv = { ...process.env };
  for (const k of Object.keys(baseEnv)) {
    if (/^FACTORY_/.test(k)) delete baseEnv[k];
  }
  const env = {
    ...baseEnv,
    TZ: perturbation.tz,
    LANG: perturbation.lang,
    LC_ALL: perturbation.lcAll,
    LC_MESSAGES: perturbation.lcAll,
    ...(perturbation.extraEnv || {}),
  };
  const r = spawnSync(process.execPath, [
    CLI_PATH,
    '--archetype', slice1e.ARCHETYPE,
    '--substitutions', absSubsPath,
    '--stdout',
  ], {
    cwd: perturbation.cwd,
    env,
    encoding: 'buffer',
    timeout: 60000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdoutBuf: Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout || ''),
    stderr: (r.stderr && r.stderr.toString('utf8')) || '',
  };
}

function runNpm(script, timeoutMs) {
  return spawnSync('npm', ['run', script], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    timeout: timeoutMs || 600000,
    shell: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function runNodeScript(relScript) {
  return spawnSync(process.execPath, [path.join(ROOT, relScript)], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function scanForbiddenPatterns(text) {
  const hits = [];
  for (const pat of slice1b.FORBIDDEN_CONTENT_PATTERNS) {
    if (pat.re.test(text)) hits.push(pat.id);
  }
  return hits;
}

function noTrailingWhitespace(text) {
  return !String(text || '').split(/\n/).some((line) => /[ \t]+$/.test(line));
}

/** Range check vs master basis — bare `git diff --check` on a clean tree can miss committed trailing WS. */
function rangeDiffCheckClean() {
  const r = spawnSync(
    'git',
    ['diff', '--check', `${slice1e.MASTER_BASIS}...HEAD`],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const detail = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0, detail: detail || '(clean)', status: r.status };
}

/**
 * RED: committed trailing whitespace is detected by candidate-range `--check`,
 * while bare working-tree `git diff --check` stays clean. Isolated temp repo only.
 */
function proveCommittedTrailingWhitespaceDetectedByRange() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1e-ws-range-'));
  const git = (args) => spawnSync('git', args, {
    cwd: tmp,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  try {
    let r = git(['init']);
    if (r.status !== 0) {
      return { ok: false, detail: `git init failed: ${(r.stderr || '').slice(0, 200)}` };
    }
    git(['config', 'user.email', 'factory1e-ws@example.invalid']);
    git(['config', 'user.name', 'factory1e-ws']);
    git(['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(tmp, 'note.md'), 'basis clean\n');
    git(['add', 'note.md']);
    r = git(['commit', '-m', 'basis']);
    if (r.status !== 0) {
      return { ok: false, detail: `basis commit failed: ${(r.stderr || r.stdout || '').slice(0, 200)}` };
    }
    const basis = git(['rev-parse', 'HEAD']).stdout.trim();
    fs.writeFileSync(path.join(tmp, 'note.md'), 'committed trailing whitespace  \n');
    git(['add', 'note.md']);
    r = git(['commit', '-m', 'trail']);
    if (r.status !== 0) {
      return { ok: false, detail: `trail commit failed: ${(r.stderr || r.stdout || '').slice(0, 200)}` };
    }
    const wt = git(['diff', '--check']);
    const range = git(['diff', '--check', `${basis}...HEAD`]);
    const rangeOut = `${range.stdout || ''}${range.stderr || ''}`;
    const ok = wt.status === 0
      && range.status !== 0
      && /trailing whitespace/i.test(rangeOut);
    return {
      ok,
      detail: `wt_status=${wt.status} range_status=${range.status} range_out=${rangeOut.slice(0, 240)}`,
    };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
}

console.log('verify:factory-slice1e-finite-closeout — FACTORY 1E\n');

// ── Artifacts ───────────────────────────────────────────────────────────────
console.log('── Artifacts ──');
ok('contract fixture exists', fs.existsSync(CONTRACT_PATH));
ok('findings exist', fs.existsSync(FINDINGS_PATH));
ok('operator handoff exists', fs.existsSync(HANDOFF_PATH));
ok('artifact lock exists', fs.existsSync(ARTIFACT_LOCK_PATH));
ok('stdout artifact exists', fs.existsSync(STDOUT_PATH));
ok('substitutions fixture exists', fs.existsSync(SUBS_PATH));
ok('doc exists', fs.existsSync(DOC_PATH));
ok('1E library exists', fs.existsSync(path.join(ROOT, 'scripts', 'lib', 'factory-slice1e-finite-closeout.js')));
ok('1E verifier exists', fs.existsSync(path.join(ROOT, 'scripts', 'verify-factory-slice1e-finite-closeout.js')));

const contract = readJson(CONTRACT_PATH);
const findings = readText(FINDINGS_PATH);
const handoff = readText(HANDOFF_PATH);
const artifactLock = readJson(ARTIFACT_LOCK_PATH);
const subs = readJson(SUBS_PATH);
const stdoutBuf = readBuf(STDOUT_PATH);
const stdoutText = stdoutBuf.toString('utf8');
const doc = readText(DOC_PATH);
const slice1aContract = readJson(SLICE1A_CONTRACT_PATH);

ok('contract slice FACTORY-1E', contract.slice === slice1e.SLICE);
ok('contract outcome_id', contract.outcome_id === slice1e.OUTCOME_ID);
ok('contract master basis e8452d17…', contract.master_basis === slice1e.MASTER_BASIS);
ok('contract completion_requires', contract.completion_requires === slice1e.COMPLETION_REQUIRES);
ok('contract live_mutation false', contract.live_mutation === false);
ok('contract runtime_behavior_changed false', contract.runtime_behavior_changed === false);
ok('contract generator_behavior_changed false', contract.generator_behavior_changed === false);
ok('contract template_behavior_changed false', contract.template_behavior_changed === false);
ok('contract apply_path false', contract.apply_path === false);
ok('contract disk_materialization_supported false', contract.disk_materialization_supported === false);
ok('findings cite master basis', findings.includes(slice1e.MASTER_BASIS));
ok('findings cite synthetic slug', findings.includes(slice1e.CLIENT_SLUG));
ok('handoff stdout preview only', /stdout/i.test(handoff) && /preview only/i.test(handoff));
ok('handoff disk/apply unsupported', /disk/i.test(handoff) && /apply/i.test(handoff) && /unsupported/i.test(handoff));
ok('handoff RADAR reopen required', /third_tenant_factory/.test(handoff) && /RADAR/i.test(handoff));
ok('handoff no production/staging/deploy',
  /no production/i.test(handoff) && /staging/i.test(handoff) && /deploy/i.test(handoff));
ok('doc marks 1E complete', /1E.*Complete/i.test(doc) || /\*\*1E\*\*.*Complete/i.test(doc));

// ── Artifact lock + substitutions identity ──────────────────────────────────
console.log('\n── Synthetic third-tenant identity ──');
ok('lock archetype surf_house', artifactLock.archetype === slice1e.ARCHETYPE);
ok('lock client_slug', artifactLock.client_slug === slice1e.CLIENT_SLUG);
ok('lock location_ids', slice1e.deepEqual(artifactLock.location_ids, [...slice1e.LOCATION_IDS]));
ok('subs CLIENT_SLUG', subs.CLIENT_SLUG === slice1e.CLIENT_SLUG);
ok('subs LOCATION_ID', subs.LOCATION_ID === slice1e.LOCATION_IDS[0]);
ok('subs CLIENT_NAME clearly synthetic', /synthetic/i.test(String(subs.CLIENT_NAME)));
ok('typed substitutions retain numbers', typeof subs.DEPOSIT_DEFAULT_EUR === 'number');
ok('typed substitutions retain integers', Number.isSafeInteger(subs.DEPOSIT_DEFAULT_CENTS));

{
  const identityBlob = [
    subs.CLIENT_SLUG, subs.LOCATION_ID, subs.CLIENT_NAME, subs.BRAND_NAME,
    artifactLock.client_slug, ...(artifactLock.location_ids || []),
  ].join('\n');
  red('synthetic_identity_excludes_forbidden_tokens',
    !slice1e.identityTextHasForbiddenToken(identityBlob),
    identityBlob.slice(0, 200));
}

// ── Exact committed artifact ────────────────────────────────────────────────
console.log('\n── Committed stdout artifact ──');
const committedSha = sha256Hex(stdoutBuf);
ok('stdout bytes match lock', stdoutBuf.length === artifactLock.stdout_bytes);
ok('stdout sha256 matches lock', committedSha === artifactLock.stdout_sha256);
green('committed_stdout_sha_locked', committedSha === artifactLock.stdout_sha256);

let envelope;
try {
  envelope = JSON.parse(stdoutText);
  ok('stdout is JSON envelope', true);
} catch (err) {
  ok('stdout is JSON envelope', false, String(err.message));
  envelope = null;
}

if (envelope) {
  ok('envelope apply false', envelope.apply === false);
  ok('envelope disk_materialization_supported false', envelope.disk_materialization_supported === false);
  ok('envelope writes false', envelope.writes === false);
  ok('envelope mode dry-run', envelope.mode === 'dry-run');
  ok('manifest enablement_forced_false', envelope.manifest && envelope.manifest.enablement_forced_false === true);
  ok('manifest writes_config_clients false', envelope.manifest.writes_config_clients === false);
  ok('manifest writes_registry false', envelope.manifest.writes_registry === false);
  ok('manifest runtime_loading false', envelope.manifest.runtime_loading === false);
  ok('manifest network/db/cloud false',
    envelope.manifest.network === false
    && envelope.manifest.db === false
    && envelope.manifest.cloud === false);
  ok('manifest secrets_materialized false', envelope.manifest.secrets_materialized === false);
  ok('manifest client_slug', envelope.manifest.client_slug === slice1e.CLIENT_SLUG);
  ok('manifest archetype', envelope.manifest.archetype === slice1e.ARCHETYPE);

  const manifestFile = envelope.files.find((f) => f.kind === 'manifest');
  ok('manifest file sha matches lock',
    manifestFile && manifestFile.sha256 === artifactLock.manifest_sha256);

  const lockFiles = artifactLock.files || {};
  const envPaths = (envelope.files || []).map((f) => f.relativePath).sort();
  const lockPaths = Object.keys(lockFiles).sort();
  ok('exact file path set', slice1e.deepEqual(envPaths, lockPaths),
    `env=${envPaths.join(',')} lock=${lockPaths.join(',')}`);

  for (const f of envelope.files || []) {
    const row = lockFiles[f.relativePath];
    ok(`file hash ${f.relativePath}`,
      row && row.sha256 === f.sha256 && row.kind === f.kind,
      row ? `${row.sha256} vs ${f.sha256}` : 'missing lock row');
  }

  const baseline = envelope.files.find((f) => f.kind === 'baseline');
  if (baseline) {
    const b = JSON.parse(baseline.content);
    ok('baseline live_enabled false', b.live_enabled === false);
    ok('baseline deployment.enabled false', b.deployment && b.deployment.enabled === false);
    ok('baseline whatsapp.enabled false', b.channels && b.channels.whatsapp && b.channels.whatsapp.enabled === false);
    ok('baseline email.enabled false', b.channels && b.channels.email && b.channels.email.enabled === false);
    ok('baseline payment_link_auto_allowed false',
      b.payment && b.payment.payment_link_auto_allowed === false);
  }

  const forbiddenHits = scanForbiddenPatterns(stdoutText);
  red('artifact_has_no_secret_or_live_target_patterns',
    forbiddenHits.length === 0,
    forbiddenHits.join(','));
}

// ── Fresh-process regeneration + side-effect proof ──────────────────────────
console.log('\n── Fresh-process regeneration (exact bytes) ──');
const beforeClients = clientsTreeSnapshot();
const beforeRegistry = registrySnapshot();
const beforeTemplates = archetypeTemplateSnapshot();

const perturbations = [
  {
    label: 'baseline',
    cwd: ROOT,
    tz: 'UTC',
    lang: 'C',
    lcAll: 'C',
    extraEnv: {},
  },
  {
    label: 'cwd_tmp_tz_madrid',
    cwd: require('os').tmpdir(),
    tz: 'Europe/Madrid',
    lang: 'es_ES.UTF-8',
    lcAll: 'es_ES.UTF-8',
    extraEnv: { IRRELEVANT_1E: 'x' },
  },
  {
    label: 'tz_tokyo_locale_c',
    cwd: path.join(ROOT, 'scripts'),
    tz: 'Asia/Tokyo',
    lang: 'C.UTF-8',
    lcAll: 'C',
    extraEnv: { HELLO: 'world' },
  },
];

const regenerated = [];
for (const p of perturbations) {
  const r = runCliFresh(SUBS_PATH, p);
  ok(`fresh CLI ${p.label} exit 0`, r.status === 0, r.stderr.slice(-400));
  ok(`fresh CLI ${p.label} exact stdout bytes`,
    r.status === 0 && r.stdoutBuf.equals(stdoutBuf),
    r.status === 0
      ? `got sha ${sha256Hex(r.stdoutBuf)} expected ${committedSha}`
      : 'cli failed');
  regenerated.push(r);
}

green('fresh_process_byte_identical_to_committed_artifact',
  regenerated.every((r) => r.status === 0 && r.stdoutBuf.equals(stdoutBuf)));

{
  // In-process library path must also match (no FS writes).
  const traps = installFsWriteTraps();
  let libOk = false;
  let libSha = '';
  try {
    const gen = require('./lib/factory-slice1c-dry-run-generator');
    const result = gen.generateDryRunPreview({
      repoRoot: ROOT,
      archetype: slice1e.ARCHETYPE,
      mode: 'dry-run',
      substitutions: subs,
    });
    const emitted = result.ok ? gen.emitStdout(result) : { ok: false };
    libOk = !!(emitted.ok && Buffer.from(emitted.stdout, 'utf8').equals(stdoutBuf));
    if (emitted.ok) libSha = sha256Hex(Buffer.from(emitted.stdout, 'utf8'));
  } finally {
    traps.restore();
  }
  green('in_process_library_matches_committed_stdout', libOk, `sha=${libSha}`);
  red('in_process_generation_zero_fs_writes', traps.hits.length === 0,
    traps.hits.slice(0, 5).map((h) => h.name).join(','));
}

const afterClients = clientsTreeSnapshot();
const afterRegistry = registrySnapshot();
const afterTemplates = archetypeTemplateSnapshot();
green('config_clients_immutable_during_1e', slice1e.deepEqual(beforeClients, afterClients));
green('registry_immutable_during_1e', slice1e.deepEqual(beforeRegistry, afterRegistry));
green('archetype_templates_immutable_during_1e', slice1e.deepEqual(beforeTemplates, afterTemplates));

{
  const refErrors = slice1b.validateReferenceBytesAgainstMaster(ROOT);
  green('reference_blobs_unchanged_via_1b_helper',
    Array.isArray(refErrors) && refErrors.length === 0,
    (refErrors || []).join(','));
}

// ── Tip scope ───────────────────────────────────────────────────────────────
console.log('\n── Tip scope ──');
{
  // Committed range only (basis...HEAD) — unrelated master paths outside factory
  // scope never enter the allowlist check; detached HEAD is fine.
  let changed = [];
  try {
    changed = spawnSync('git', [
      'diff', '--name-only', `${slice1e.MASTER_BASIS}...HEAD`,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
    }).stdout.trim().split('\n').filter(Boolean);
  } catch (_) {
    changed = [];
  }
  let dirtyFactory = [];
  try {
    const dirty = spawnSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).stdout.trim().split('\n').filter(Boolean);
    const staged = spawnSync('git', ['diff', '--cached', '--name-only'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).stdout.trim().split('\n').filter(Boolean);
    const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).stdout.trim().split('\n').filter(Boolean);
    dirtyFactory = [...new Set(dirty.concat(staged, untracked))];
  } catch (_) {
    dirtyFactory = [];
  }
  const factoryTouched = [...new Set([...changed, ...dirtyFactory])].filter((p) => (
    p.startsWith('fixtures/factory-client-productization/')
    || p.startsWith('scripts/lib/factory-slice1')
    || p.startsWith('scripts/verify-factory-slice1')
    || p === 'scripts/onboard-client.js'
    || p === 'docs/FACTORY-CLIENT-PRODUCTIZATION.md'
    || p === 'package.json'
    || p.startsWith('config/archetypes/')
    || p.startsWith('config/clients/')
  ));
  const tipCheck = tipPathsAllowed(factoryTouched);
  ok('1E tip paths within allowlist', tipCheck.ok, tipCheck.bad.join(','));
  red('no_archetype_template_edits_in_tip',
    !factoryTouched.some((p) => p.startsWith('config/archetypes/')));
  red('no_config_clients_edits_in_tip',
    !factoryTouched.some((p) => p.startsWith('config/clients/')));
  red('no_onboard_cli_edits_in_tip',
    !factoryTouched.includes('scripts/onboard-client.js'));
  // 1B/1C/1D lock modules may gain forward-compat tip allowlist entries for 1E
  // paths only — not generator/CLI algorithm changes.
  {
    const genDiff = spawnSync('git', [
      'diff', slice1e.MASTER_BASIS, '--', 'scripts/lib/factory-slice1c-dry-run-generator.js',
    ], { cwd: ROOT, encoding: 'utf8' }).stdout || '';
    const suspicious = genDiff.split('\n').filter((line) => (
      /^\+[^+]/.test(line)
      && !/ALLOWED_TIP_PATH_PREFIXES|factory-slice1[de]|verify-factory-slice1[de]|messi-slice1[a-d]|MESSI-ACCEPTANCE|FOUNDATION|FORTRESS|fixtures\/messi-acceptance|fixtures\/foundation-closeout|fixtures\/fortress-closeout|Forward-compat tip-allowlist/.test(line)
      && !/^\+\s*$/.test(line)
      && !/^\+\s*['"]scripts\//.test(line)
      && !/^\+\s*['"]docs\//.test(line)
      && !/^\+\s*\],?$/.test(line)
    ));
    red('1c_generator_diff_tip_allowlist_only',
      !factoryTouched.includes('scripts/lib/factory-slice1c-dry-run-generator.js')
      || suspicious.length === 0,
      suspicious.slice(0, 8).join(' | '));
  }
}

// ── Source fences ───────────────────────────────────────────────────────────
console.log('\n── Source fences ──');
{
  const verifierSrc = readText(path.join(ROOT, 'scripts', 'verify-factory-slice1e-finite-closeout.js'));
  red('no_factory_skip_or_probe_env_bypasses',
    !/process\.env\.FACTORY_\w*(SKIP|PROBE)/.test(verifierSrc)
    && !/FACTORY_1[ABCDE]_(SKIP|LEDGER_PROBE|SKIP_NESTED|SKIP_LEGACY)/.test(verifierSrc));
  red('1e_does_not_export_write_or_apply_apis',
    typeof slice1e.writeDryRunPreview !== 'function'
    && typeof slice1e.generateDryRunPreview !== 'function');
  red('verifier_pins_fail_closed_candidate_range_diff_check',
    verifierSrc.includes('${slice1e.MASTER_BASIS}...HEAD')
    && /diff', '--check', `\$\{slice1e\.MASTER_BASIS\}\.\.\.HEAD`/.test(verifierSrc)
    && !/ok\('git diff --check clean'/.test(verifierSrc));
}

// ── 1A ledger must claim 1E complete with evidence (structural) ─────────────
console.log('\n── 1A ledger closeout fields ──');
{
  const stage1e = slice1aContract.finite_stages.find((s) => s.id === '1E');
  ok('1A contract stage 1E complete', stage1e && stage1e.status === 'complete');
  ok('1A contract 1E completion_evidence',
    stage1e && stage1e.completion_evidence === slice1e.COMPLETION_EVIDENCE);
  ok('1A contract 1E completion_requires',
    stage1e && stage1e.completion_requires === slice1e.COMPLETION_REQUIRES);
  const byId = new Map(slice1aContract.gates.map((g) => [g.id, g]));
  ok('G_DRY_RUN_PROOF evidence is 1E closeout',
    byId.get('G_DRY_RUN_PROOF')
    && byId.get('G_DRY_RUN_PROOF').current_stage_evidence === slice1e.COMPLETION_EVIDENCE);
  ok('G_MILESTONE_CLOSEOUT evidence is 1E closeout',
    byId.get('G_MILESTONE_CLOSEOUT')
    && byId.get('G_MILESTONE_CLOSEOUT').current_stage_evidence === slice1e.COMPLETION_EVIDENCE);

  const lockStage = slice1a.FINITE_STAGES.find((s) => s.id === '1E');
  ok('1A lock module stage 1E complete',
    lockStage && lockStage.status === 'complete'
    && lockStage.completion_requires === slice1e.COMPLETION_REQUIRES);

  red('R_1E_complete_without_independent_validator',
    slice1e.validate1eLedgerClaim(
      {
        id: '1E',
        status: 'complete',
        completion_evidence: slice1e.COMPLETION_EVIDENCE,
        completion_requires: slice1e.COMPLETION_REQUIRES,
      },
      slice1aContract.gates,
      false,
    ).includes('1e_complete_without_independent_validator'));
}

// Snapshot fail count before nested gates — closeout claim requires nested PASS.
const failsBeforeNested = fail;

// ── Nested prior factory gates (1A–1D) ──────────────────────────────────────
console.log('\n── Nested prior factory gates (1A–1D) ──');
{
  // Structural recursion: 1E invokes 1A–1D. 1A must not invoke 1E (avoids loop).
  const aSrc = readText(path.join(ROOT, 'scripts', 'verify-factory-slice1a-acceptance-contract.js'));
  red('1a_does_not_invoke_1e',
    !/npm['"\s,]*run['"\s,]*verify:factory-slice1e/.test(aSrc)
    && !/spawnSync\([^)]*verify-factory-slice1e/.test(aSrc)
    && !/runNpm\(['"]verify:factory-slice1e/.test(aSrc));

  for (const script of [
    'verify:factory-slice1a-acceptance-contract',
    'verify:factory-slice1b-archetype-templates',
    'verify:factory-slice1c-dry-run-generator',
    'verify:factory-slice1d-integration-proof',
  ]) {
    const r = runNpm(script, 1800000);
    ok(`${script} exit 0`, r.status === 0,
      r.status !== 0 ? (r.stderr || r.stdout || '').slice(-800) : '');
  }
}

// ── Legacy Luna + hard multiclient gates ────────────────────────────────────
console.log('\n── Legacy Luna + hard multiclient gates ──');
{
  const luna = runNpm('verify:luna-all', 900000);
  ok('npm run verify:luna-all exit 0', luna.status === 0,
    luna.status !== 0 ? (luna.stderr || luna.stdout || '').slice(-800) : '');

  const hardScripts = [
    'scripts/verify-multiclient-isolation.js',
    'scripts/verify-no-client-hardcoding.js',
    'scripts/verify-tenant-resolution.js',
    'scripts/verify-meta-whatsapp-tenant-shadow.js',
  ];
  for (const rel of hardScripts) {
    const r = runNodeScript(rel);
    ok(`${rel} exit 0`, r.status === 0,
      r.status !== 0 ? (r.stderr || r.stdout || '').slice(-400) : '');
  }

  console.log('\n── Retained master RED classification (honest) ──');
  for (const row of slice1e.EXISTING_REGRESSION_RETAINED_MASTER_RED) {
    const rel = row.gate.replace(/^node\s+/, '');
    const r = runNodeScript(rel);
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    const stillRed = r.status !== 0;
    ok(`${rel} still RED (retained pre-existing)`, stillRed,
      stillRed ? '' : 'unexpectedly green — update retained_master_red lock');
    const marker = row.retained_failure.split('(')[0].trim();
    ok(`${rel} retains expected failure marker`,
      stillRed && out.includes(marker),
      `expected to mention: ${row.retained_failure}`);
  }
}

{
  ok('handoff has no trailing whitespace', noTrailingWhitespace(handoff));
  ok('findings have no trailing whitespace', noTrailingWhitespace(findings));

  const rangeCheck = rangeDiffCheckClean();
  ok('git range diff --check clean vs master basis', rangeCheck.ok, rangeCheck.detail);
  ok('contract gates pin range diff --check',
    Array.isArray(contract.gates_npm)
    && contract.gates_npm.includes(slice1e.RANGE_DIFF_CHECK_GATE)
    && slice1e.RANGE_DIFF_CHECK_GATE === `git diff --check ${slice1e.MASTER_BASIS}...HEAD`);

  const committedWsRed = proveCommittedTrailingWhitespaceDetectedByRange();
  red('committed_trailing_whitespace_detected_by_candidate_range',
    committedWsRed.ok, committedWsRed.detail);
}

// ── Milestone closeout claim (only after proof) ─────────────────────────────
console.log('\n── Milestone closeout claim ──');
const nestedClean = fail === failsBeforeNested;
const slice1eVerifierPassed = nestedClean && fail === failsBeforeNested;
{
  // Re-evaluate: closeout claim is true only when this verifier reaches here
  // with zero failures so far (artifact + nested gates + retained RED honesty).
  const passedSoFar = fail === 0;
  const ledgerErrs = slice1e.validate1eLedgerClaim(
    slice1aContract.finite_stages.find((s) => s.id === '1E'),
    slice1aContract.gates,
    passedSoFar,
  );
  ok('1E ledger complete only after independent proof',
    ledgerErrs.length === 0,
    ledgerErrs.join(','));

  const lockErrs = slice1a.validate1eLedgerClaim
    ? slice1a.validate1eLedgerClaim(
      slice1a.FINITE_STAGES.find((s) => s.id === '1E'),
      slice1a.GATES,
      passedSoFar,
    )
    : ['1a_missing_validate1eLedgerClaim'];
  ok('1A lock validate1eLedgerClaim agrees',
    lockErrs.length === 0,
    lockErrs.join(','));

  green('five_stages_nine_gates_complete_after_proof',
    passedSoFar
    && slice1aContract.finite_stages.every((s) => s.status === 'complete')
    && slice1aContract.gates.length === 9
    && slice1aContract.gates.every((g) => (
      g.current_stage_evidence
      && g.current_stage_evidence !== 'gate_text_freeze_only'
      && g.current_stage_evidence !== 'closeout_deferred_to_1E'
    )));
}

ok('proves/does_not_prove frozen in lock',
  Array.isArray(slice1e.PROVES) && slice1e.PROVES.length > 0
  && Array.isArray(slice1e.DOES_NOT_PROVE)
  && slice1e.DOES_NOT_PROVE.includes('live_or_prod_third_tenant_onboarding'));
ok('findings state what FACTORY does/not prove',
  /does not prove/i.test(findings) && /proves/i.test(findings));
ok('handoff lists manual future review steps',
  /manual/i.test(handoff) && /review/i.test(handoff));

console.log(`\n── factory-slice1e: ${pass} passed, ${fail} failed ──`);
console.log(`  RED ${redResults.filter((r) => r.ok).length}/${redResults.length}  GREEN ${greenResults.filter((g) => g.ok).length}/${greenResults.length}`);

if (fail > 0) process.exit(1);
console.log('FACTORY Slice 1E finite closeout: PASS');
process.exit(0);
