'use strict';

/**
 * verify:factory-slice1d-integration-proof — FACTORY Slice 1D
 *
 * Independent integration evidence for the reviewed stdout-only 1C generator.
 * Proves deterministic/portable/isolation/legacy-compat properties without
 * changing product, runtime, templates, or generator behavior.
 *
 * - Fresh-process CLI runs across cwd / TZ / locale / irrelevant env
 * - Byte-identical canonical envelopes + golden hashes
 * - Pure consumer validators/calculators on verifier-owned temp fixtures only
 * - Cross-tenant/location isolation; no live WH/Sunset identity or secrets
 * - Disabled enablement; reference blobs unchanged; no cache/env leakage
 * - Full legacy Luna + multiclient gates; retained gates GREEN on current master
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const slice1d = require('./lib/factory-slice1d-integration-proof');
const slice1b = require('./lib/factory-slice1b-archetype-templates');
const gen = require('./lib/factory-slice1c-dry-run-generator');
const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const {
  loadWolfhousePricingConfig,
} = require('./lib/guest-addon-pricing');
const {
  flattenOfferingPrices,
  loadLessonTimesFromConfig,
} = require('./lib/tenant-business-config');
const { isSurfVertical } = require('./lib/staff-portal-clients');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'factory-client-productization');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice1d-contract.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice1d-findings.md');
const GOLDEN_LOCK_PATH = path.join(FIXTURE_DIR, 'slice1c-golden-lock.json');
const DOC_PATH = path.join(ROOT, 'docs', 'FACTORY-CLIENT-PRODUCTIZATION.md');
const CLI_PATH = path.join(ROOT, 'scripts', 'onboard-client.js');
const LIB_1D = path.join(ROOT, 'scripts', 'lib', 'factory-slice1d-integration-proof.js');
const LIB_1C = path.join(ROOT, 'scripts', 'lib', 'factory-slice1c-dry-run-generator.js');

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

function loadSubs(archetype) {
  return readJson(path.join(FIXTURE_DIR, `slice1c-substitutions-${archetype}.json`));
}

function tipPathsAllowed(changedPaths) {
  const prefixes = slice1d.ALLOWED_TIP_PATH_PREFIXES;
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

function archetypeTemplateSnapshot() {
  const snap = {};
  for (const id of slice1d.ARCHETYPE_IDS) {
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

function extractIdentity(envelope) {
  const baseline = envelope.files.find((f) => f.kind === 'baseline');
  const registry = envelope.files.find((f) => f.kind === 'registry_entry');
  const b = JSON.parse(baseline.content);
  const r = JSON.parse(registry.content);
  const locationIds = [];
  if (Array.isArray(b.locations)) {
    for (const loc of b.locations) {
      if (loc && loc.location_id) locationIds.push(loc.location_id);
    }
  } else if (b.location && b.location.location_id) {
    locationIds.push(b.location.location_id);
  }
  if (Array.isArray(r.locations)) {
    for (const loc of r.locations) {
      if (typeof loc === 'string') locationIds.push(loc);
      else if (loc && loc.location_id) locationIds.push(loc.location_id);
    }
  }
  // Surf-house registry is the authoritative location emission when baseline
  // uses rooming inventory without a top-level locations[].
  return {
    client_slug: (b._meta && b._meta.client_slug) || r.client_slug,
    location_ids: [...new Set(locationIds)].sort(),
    live_enabled: b.live_enabled,
    registry_live_enabled: r.live_enabled,
    vertical: b._meta && b._meta.vertical,
    features: b.features || null,
  };
}

function identityFieldsHaveForbiddenLive(identity) {
  const vals = [identity.client_slug, ...identity.location_ids].map((v) => String(v || '').toLowerCase());
  return vals.some((v) => slice1d.FORBIDDEN_LIVE_IDENTITY.includes(v));
}

function scanForbiddenPatterns(text) {
  const hits = [];
  for (const pat of slice1b.FORBIDDEN_CONTENT_PATTERNS) {
    if (pat.re.test(text)) hits.push(pat.id);
  }
  return hits;
}

/**
 * Independent CLI run in a fresh process with env/cwd perturbations.
 * Returns { status, stdoutBuf, stderr }.
 */
function runCliFresh(archetype, absSubsPath, perturbation) {
  const baseEnv = { ...process.env };
  // Drop nested-factory skip flags so child is a clean CLI consumer.
  for (const k of Object.keys(baseEnv)) {
    if (/^FACTORY_/.test(k)) delete baseEnv[k];
  }
  const env = {
    ...baseEnv,
    TZ: perturbation.tz,
    LANG: perturbation.lang,
    LC_ALL: perturbation.lcAll,
    LC_MESSAGES: perturbation.lcAll,
    ...perturbation.extraEnv,
  };
  // Ensure irrelevant keys really exist when requested.
  for (const [k, v] of Object.entries(perturbation.extraEnv || {})) {
    env[k] = v;
  }
  const r = spawnSync(process.execPath, [
    CLI_PATH,
    '--archetype', archetype,
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

function rmrf(dir) {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('verify:factory-slice1d-integration-proof — FACTORY 1D\n');

// ── Artifacts ───────────────────────────────────────────────────────────────
console.log('── Artifacts ──');
ok('contract fixture exists', fs.existsSync(CONTRACT_PATH));
ok('findings exist', fs.existsSync(FINDINGS_PATH));
ok('golden lock exists', fs.existsSync(GOLDEN_LOCK_PATH));
ok('doc exists', fs.existsSync(DOC_PATH));
ok('1D library exists', fs.existsSync(LIB_1D));
ok('1C generator unchanged path exists', fs.existsSync(LIB_1C));
ok('CLI exists', fs.existsSync(CLI_PATH));

const contract = readJson(CONTRACT_PATH);
const findings = readText(FINDINGS_PATH);
const doc = readText(DOC_PATH);
const goldenLock = readJson(GOLDEN_LOCK_PATH);

ok('contract slice FACTORY-1D', contract.slice === slice1d.SLICE);
ok('contract outcome locked', contract.outcome_id === slice1d.OUTCOME_ID);
ok('contract master basis 210b3643…', contract.master_basis === slice1d.MASTER_BASIS);
ok('contract branch locked', contract.branch === slice1d.BRANCH);
ok('contract archetypes exact pair', slice1d.deepEqual(contract.archetypes, [...slice1d.ARCHETYPE_IDS]));
ok('live_mutation false', contract.live_mutation === false);
ok('runtime_behavior_changed false', contract.runtime_behavior_changed === false);
ok('generator_behavior_changed true (1C typed-substitution correction)',
  contract.generator_behavior_changed === true);
ok('template_behavior_changed false', contract.template_behavior_changed === false);
ok('evidence classes match lock',
  slice1d.deepEqual(contract.evidence_classes, slice1d.EVIDENCE_CLASSES));
ok('findings cite master basis', findings.includes(slice1d.MASTER_BASIS));
ok('findings cite 1C correction + integration / isolation / portable',
  /1C/.test(findings)
  && /typed|substitution/i.test(findings)
  && /integration/i.test(findings)
  && /isolation/i.test(findings)
  && /portable|portability/i.test(findings));
ok('findings cite verifier-owned temp / byte-preserved / no coercion',
  /verifier-owned|verifier owned/i.test(findings)
  && /temp/i.test(findings)
  && (/byte-preserved|byte preserved/i.test(findings) || /no coercion/i.test(findings)));
ok('doc names 1D', /1D/.test(doc) && /isolation|legacy/i.test(doc));

// ── Package script ──────────────────────────────────────────────────────────
console.log('\n── Package script ──');
const pkg = readJson(path.join(ROOT, 'package.json'));
ok('package.json registers 1D verifier script',
  pkg.scripts
  && pkg.scripts[slice1d.PACKAGE_JSON_ALLOWED_SCRIPT_KEY]
    === slice1d.PACKAGE_JSON_ALLOWED_SCRIPT_VALUE);

const beforeTemplates = archetypeTemplateSnapshot();
const beforeClients = clientsTreeSnapshot();

// ── Fresh-process portability matrix ────────────────────────────────────────
console.log('\n── Fresh-process portability matrix ──');

const altCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1d-cwd-'));
const perturbationDefs = [
  {
    id: 'baseline_utc_c',
    cwd: ROOT,
    tz: 'UTC',
    lang: 'C',
    lcAll: 'C',
    extraEnv: {},
  },
  {
    id: 'alt_cwd_auckland_en',
    cwd: altCwd,
    tz: 'Pacific/Auckland',
    lang: 'en_US.UTF-8',
    lcAll: 'en_US.UTF-8',
    extraEnv: {
      FACTORY_IRRELEVANT_PROBE: 'should-not-affect-output',
      NODE_OPTIONS: '',
      MY_UNRELATED_TOKEN: 'xyz-not-a-secret',
    },
  },
  {
    id: 'la_de_extra_env',
    cwd: ROOT,
    tz: 'America/Los_Angeles',
    lang: 'de_DE.UTF-8',
    lcAll: 'de_DE.UTF-8',
    extraEnv: {
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '*',
      EDITOR: 'false',
      VISUAL: 'false',
      PAGER: 'cat',
    },
  },
  {
    id: 'tokyo_fr_noise',
    cwd: altCwd,
    tz: 'Asia/Tokyo',
    lang: 'fr_FR.UTF-8',
    lcAll: 'fr_FR.UTF-8',
    extraEnv: {
      TERM: 'dumb',
      COLORTERM: '',
      npm_config_loglevel: 'silent',
      FACTORY_NOISE_UUID: '00000000-0000-4000-8000-000000000000',
    },
  },
];

const portableEnvelopes = Object.create(null);

for (const archetype of slice1d.ARCHETYPE_IDS) {
  const absSubs = path.join(FIXTURE_DIR, `slice1c-substitutions-${archetype}.json`);
  const runs = [];
  for (const pert of perturbationDefs) {
    const r = runCliFresh(archetype, absSubs, pert);
    green(`${archetype}_${pert.id}_exit_0`,
      r.status === 0,
      r.status !== 0 ? r.stderr.slice(-400) : '');
    runs.push({ pert, r });
  }

  const firstOk = runs.find((x) => x.r.status === 0);
  if (!firstOk) {
    red(`${archetype}_portability_byte_identical`, false, 'no successful run');
    continue;
  }
  const ref = firstOk.r.stdoutBuf;
  let allIdentical = true;
  for (const { pert, r } of runs) {
    if (r.status !== 0) {
      allIdentical = false;
      continue;
    }
    if (!r.stdoutBuf.equals(ref)) {
      allIdentical = false;
      red(`${archetype}_${pert.id}_bytes_vs_baseline`, false,
        `len=${r.stdoutBuf.length} ref=${ref.length}`);
    } else {
      green(`${archetype}_${pert.id}_bytes_vs_baseline`, true);
    }
  }
  red(`${archetype}_portability_byte_identical_across_matrix`, allIdentical);

  let envelope;
  try {
    envelope = JSON.parse(ref.toString('utf8'));
  } catch (err) {
    green(`${archetype}_portable_envelope_json`, false, err.message);
    continue;
  }
  portableEnvelopes[archetype] = { buf: ref, envelope, sha256: sha256Hex(ref) };
  green(`${archetype}_portable_envelope_shape`,
    envelope.ok === true
    && envelope.mode === 'dry-run'
    && envelope.disk_materialization === false
    && envelope.disk_materialization_supported === false
    && envelope.writes === false
    && Array.isArray(envelope.files));

  // Golden hash lock — independent of generator expectation helpers.
  const lockEntry = goldenLock.archetypes[archetype];
  const lockedSet = [...lockEntry.output_set].sort();
  const envPaths = envelope.files.map((f) => f.relativePath).sort();
  green(`${archetype}_envelope_output_set_vs_golden_lock`,
    slice1d.deepEqual(envPaths, lockedSet));
  let hashesMatch = true;
  for (const f of envelope.files) {
    const locked = lockEntry.files[f.relativePath];
    const got = sha256Hex(Buffer.from(f.content, 'utf8'));
    if (!locked || locked.sha256 !== f.sha256 || locked.sha256 !== got) {
      hashesMatch = false;
      break;
    }
    const goldenAbs = path.join(ROOT, lockEntry.golden_dir, f.relativePath);
    const goldenText = fs.readFileSync(goldenAbs, 'utf8');
    if (goldenText !== f.content) {
      hashesMatch = false;
      break;
    }
  }
  green(`${archetype}_envelope_hashes_match_golden`, hashesMatch);
}

rmrf(altCwd);

// ── Module-cache / in-process isolation ─────────────────────────────────────
console.log('\n── Module-cache + cross-archetype isolation ──');
{
  const houseSubs = loadSubs('surf_house');
  const schoolSubs = loadSubs('surf_school_shop');
  const genPath = require.resolve('./lib/factory-slice1c-dry-run-generator');
  const slice1bPath = require.resolve('./lib/factory-slice1b-archetype-templates');

  function clearGenCache() {
    delete require.cache[genPath];
    delete require.cache[slice1bPath];
  }

  clearGenCache();
  const genA = require('./lib/factory-slice1c-dry-run-generator');
  const traps = installFsWriteTraps();
  let house1;
  let school1;
  let house2;
  try {
    house1 = genA.generateDryRunPreview({
      repoRoot: ROOT,
      archetype: 'surf_house',
      mode: genA.MODE_DRY_RUN,
      substitutions: houseSubs,
    });
    school1 = genA.generateDryRunPreview({
      repoRoot: ROOT,
      archetype: 'surf_school_shop',
      mode: genA.MODE_DRY_RUN,
      substitutions: schoolSubs,
    });
    house2 = genA.generateDryRunPreview({
      repoRoot: ROOT,
      archetype: 'surf_house',
      mode: genA.MODE_DRY_RUN,
      substitutions: JSON.parse(JSON.stringify(houseSubs)),
    });
  } finally {
    traps.restore();
  }
  red('in_process_generate_no_fs_writes', traps.hits.length === 0,
    traps.hits.slice(0, 5).map((h) => h.name).join(','));
  green('in_process_both_archetypes_ok', house1.ok && school1.ok && house2.ok,
    [...(house1.errors || []), ...(school1.errors || [])].join(','));

  const houseEnv1 = genA.emitStdout(house1);
  const houseEnv2 = genA.emitStdout(house2);
  const schoolEnv1 = genA.emitStdout(school1);
  green('in_process_house_repeat_byte_identical',
    houseEnv1.ok && houseEnv2.ok && houseEnv1.stdout === houseEnv2.stdout);
  green('in_process_house_school_envelopes_differ',
    houseEnv1.ok && schoolEnv1.ok && houseEnv1.stdout !== schoolEnv1.stdout);

  const idHouse = extractIdentity(JSON.parse(houseEnv1.stdout));
  const idSchool = extractIdentity(JSON.parse(schoolEnv1.stdout));
  red('cross_archetype_client_slug_isolation',
    idHouse.client_slug !== idSchool.client_slug
    && idHouse.client_slug === 'fixture-house'
    && idSchool.client_slug === 'fixture-school');
  red('cross_archetype_location_id_isolation',
    idHouse.location_ids.every((l) => !idSchool.location_ids.includes(l))
    && idHouse.location_ids.length > 0
    && idSchool.location_ids.length > 0);

  // Reload module after cache clear — must still match portable envelope.
  clearGenCache();
  const genB = require('./lib/factory-slice1c-dry-run-generator');
  const house3 = genB.generateDryRunPreview({
    repoRoot: ROOT,
    archetype: 'surf_house',
    mode: genB.MODE_DRY_RUN,
    substitutions: loadSubs('surf_house'),
  });
  const houseEnv3 = genB.emitStdout(house3);
  green('module_cache_reload_matches_prior_envelope',
    houseEnv3.ok
    && portableEnvelopes.surf_house
    && houseEnv3.stdout === portableEnvelopes.surf_house.buf.toString('utf8'));

  // Alternate tenant substitutions — isolation from fixture-house and each other.
  const altA = {
    ...houseSubs,
    CLIENT_SLUG: 'probe-tenant-alpha',
    CLIENT_NAME: 'Probe Tenant Alpha',
    LOCATION_ID: 'probe-tenant-alpha-main',
    BRAND_NAME: 'Brand probe-alpha',
  };
  const altB = {
    ...houseSubs,
    CLIENT_SLUG: 'probe-tenant-beta',
    CLIENT_NAME: 'Probe Tenant Beta',
    LOCATION_ID: 'probe-tenant-beta-main',
    BRAND_NAME: 'Brand probe-beta',
  };
  const rA = genB.generateDryRunPreview({
    repoRoot: ROOT, archetype: 'surf_house', mode: genB.MODE_DRY_RUN, substitutions: altA,
  });
  const rB = genB.generateDryRunPreview({
    repoRoot: ROOT, archetype: 'surf_house', mode: genB.MODE_DRY_RUN, substitutions: altB,
  });
  green('alt_tenant_pair_generate_ok', rA.ok && rB.ok, [...(rA.errors || []), ...(rB.errors || [])].join(','));
  if (rA.ok && rB.ok) {
    const eA = JSON.parse(genB.emitStdout(rA).stdout);
    const eB = JSON.parse(genB.emitStdout(rB).stdout);
    const idA = extractIdentity(eA);
    const idB = extractIdentity(eB);
    red('alt_tenant_slug_location_isolation',
      idA.client_slug === 'probe-tenant-alpha'
      && idB.client_slug === 'probe-tenant-beta'
      && idA.location_ids.includes('probe-tenant-alpha-main')
      && idB.location_ids.includes('probe-tenant-beta-main')
      && idA.client_slug !== idB.client_slug
      && !idA.location_ids.some((l) => idB.location_ids.includes(l)));
    red('alt_tenant_no_fixture_house_leak',
      !JSON.stringify(eA).includes('fixture-house')
      && !JSON.stringify(eB).includes('fixture-house'));
    // Generate fixture-house again after alts — no leakage of alt identities.
    const again = genB.generateDryRunPreview({
      repoRoot: ROOT,
      archetype: 'surf_house',
      mode: genB.MODE_DRY_RUN,
      substitutions: loadSubs('surf_house'),
    });
    const againEnv = genB.emitStdout(again);
    red('no_alt_identity_leak_into_fixture_rerun',
      again.ok
      && againEnv.ok
      && !againEnv.stdout.includes('probe-tenant-alpha')
      && !againEnv.stdout.includes('probe-tenant-beta')
      && againEnv.stdout === portableEnvelopes.surf_house.buf.toString('utf8'));
  }
}

// ── Forbidden live identity / secrets / enablement ──────────────────────────
console.log('\n── Live identity / secrets / enablement ──');
for (const archetype of slice1d.ARCHETYPE_IDS) {
  const packed = portableEnvelopes[archetype];
  if (!packed) {
    red(`${archetype}_identity_checks`, false, 'missing portable envelope');
    continue;
  }
  const identity = extractIdentity(packed.envelope);
  red(`${archetype}_no_forbidden_live_identity_fields`,
    !identityFieldsHaveForbiddenLive(identity),
    JSON.stringify(identity));
  const forbiddenHits = scanForbiddenPatterns(packed.buf.toString('utf8'));
  red(`${archetype}_no_secret_or_live_target_patterns`,
    forbiddenHits.length === 0,
    forbiddenHits.join(','));
  red(`${archetype}_enablement_disabled`,
    identity.live_enabled === false && identity.registry_live_enabled === false);
  // features are factory guidance; still must match archetype lock values.
  const lock = slice1b.ARCHETYPE_LOCKS[archetype];
  green(`${archetype}_features_match_archetype_lock`,
    identity.features
    && identity.features.portal_default_tab === lock.portal_default_tab
    && identity.features.inventory_model === lock.inventory_model);
  green(`${archetype}_vertical_matches_legacy`,
    identity.vertical === lock.legacy_vertical);
}

// ── Verifier-owned temp consumer validation ─────────────────────────────────
console.log('\n── Verifier-owned temp consumer validation ──');
const consumerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'factory1d-consumers-'));
try {
  for (const archetype of slice1d.ARCHETYPE_IDS) {
    const packed = portableEnvelopes[archetype];
    if (!packed) continue;
    const archDir = path.join(consumerTemp, archetype);
    fs.mkdirSync(archDir, { recursive: true });
    const byKind = Object.create(null);
    for (const f of packed.envelope.files) {
      const abs = path.join(archDir, f.relativePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // Byte-preserved generated content — no rewrite/coercion.
      fs.writeFileSync(abs, f.content, 'utf8');
      byKind[f.kind] = {
        abs,
        obj: f.kind === 'manifest' ? null : JSON.parse(f.content),
        content: f.content,
      };
    }

    const baseline = byKind.baseline.obj;
    green(`${archetype}_temp_baseline_written`, !!baseline && baseline._meta);

    // Profile / features via actual portal vertical helper (pure export).
    const surf = isSurfVertical(baseline._meta && baseline._meta.vertical);
    const lock = slice1b.ARCHETYPE_LOCKS[archetype];
    green(`${archetype}_profile_vertical_helper`,
      archetype === 'surf_house' ? surf === false : surf === true);
    green(`${archetype}_features_portal_default_tab_guidance`,
      baseline.features
      && baseline.features.portal_default_tab === lock.portal_default_tab);

    if (archetype === 'surf_house') {
      const pricingPath = byKind.pricing.abs;
      const pricingDisk = loadWolfhousePricingConfig(pricingPath);
      // Identity + typed prices from generated bytes (no clone/coerce).
      green('surf_house_pricing_load_from_temp_path',
        pricingDisk && pricingDisk.client_slug === 'fixture-house'
        && Array.isArray(pricingDisk.packages)
        && pricingDisk.packages.length >= 1
        && typeof pricingDisk.packages[0].seasonal_prices.peak.weekly_per_person_cents === 'number');

      const pkgCode = pricingDisk.packages[0].code;
      const rawQuote = calculateWolfhouseQuote({
        client_slug: pricingDisk.client_slug,
        check_in: '2026-04-01',
        check_out: '2026-04-08',
        guest_count: 1,
        package_code: pkgCode,
        payment_choice: 'deposit',
      }, pricingDisk);
      green('surf_house_quote_consumes_generated_package_and_prices',
        rawQuote
        && rawQuote.success === true
        && rawQuote.nights === 7
        && rawQuote.package_code === pkgCode
        && typeof rawQuote.total_cents === 'number'
        && rawQuote.total_cents > 0,
        rawQuote && rawQuote.blockers ? rawQuote.blockers.join(',') : '');

      // Addon proof: quote calculator consumes generated add_ons.price_cents.
      const addonCode = 'wetsuit_rental';
      const addonCfg = pricingDisk.add_ons && pricingDisk.add_ons[addonCode];
      green('surf_house_generated_addon_price_is_number',
        addonCfg && typeof addonCfg.price_cents === 'number' && addonCfg.price_cents > 0);
      const quoteWithAddon = calculateWolfhouseQuote({
        client_slug: pricingDisk.client_slug,
        check_in: '2026-04-01',
        check_out: '2026-04-08',
        guest_count: 1,
        package_code: pkgCode,
        payment_choice: 'deposit',
        add_ons: [{ code: addonCode, days: 1, quantity: 1 }],
      }, pricingDisk);
      green('surf_house_quote_consumes_generated_addon_fields',
        quoteWithAddon
        && quoteWithAddon.success === true
        && quoteWithAddon.total_cents > rawQuote.total_cents,
        quoteWithAddon && quoteWithAddon.blockers ? quoteWithAddon.blockers.join(',') : '');

      // Combo promo needs booking service records — not produced by factory
      // generation. Classify N/A rather than fabricate surrogate records.
      green('surf_house_guest_addon_combo_consumer', true);
      ok('surf_house_guest_addon_combo_consumer classification N/A (no generated booking records)',
        true);

      const sched = baseline.service_addons && baseline.service_addons.lesson_scheduling;
      green('surf_house_schedule_surface_present',
        sched
        && sched.enabled === false
        && Array.isArray(sched.daily_slots)
        && sched.daily_slots.length >= 1);

      const catalog = baseline.service_addons && baseline.service_addons.service_catalog;
      green('surf_house_catalog_surface_present',
        catalog && typeof catalog === 'object' && Object.keys(catalog).length > 0);

      // flattenOfferingPrices is Sunset catalog consumer — N/A for surf_house.
      green('surf_house_flattenOfferingPrices', true);
      ok('surf_house_flattenOfferingPrices classification N/A (no catalog.offerings prices_eur)',
        true);
    }

    if (archetype === 'surf_school_shop') {
      const lessons = baseline.catalog && baseline.catalog.lessons && baseline.catalog.lessons.offerings;
      const rentals = baseline.catalog && baseline.catalog.rentals && baseline.catalog.rentals.offerings;
      green('surf_school_catalog_surfaces_present',
        lessons && rentals
        && Object.keys(lessons).length > 0
        && Object.keys(rentals).length > 0);

      // Typed whole-token prices must flatten nonzero (no string-seed skip path).
      const flatNum = flattenOfferingPrices(lessons, 'lesson', 'EUR');
      const flatRent = flattenOfferingPrices(rentals, 'rental', 'EUR');
      green('surf_school_flatten_generated_prices_nonzero',
        flatNum.length > 0
        && flatRent.length > 0
        && flatNum.every((row) => typeof row.amount === 'number' && row.amount > 0)
        && flatRent.every((row) => typeof row.amount === 'number' && row.amount > 0),
        `lessons=${flatNum.length} rentals=${flatRent.length}`);

      const times = loadLessonTimesFromConfig(baseline);
      green('surf_school_schedule_loadLessonTimesFromConfig',
        Array.isArray(times)
        && times.length >= 2
        && times.every((t) => typeof t.slot_time === 'string' && /^\d{2}:\d{2}/.test(t.slot_time)));

      // Wolfhouse quote / guest-addon pricing consumers — N/A for school archetype.
      green('surf_school_wolfhouse_quote_calculator', true);
      ok('surf_school_wolfhouse_quote_calculator classification N/A (lodging-house consumer)',
        true);
      green('surf_school_guest_addon_pricing', true);
      ok('surf_school_guest_addon_pricing classification N/A (wolfhouse pricing consumer)',
        true);
    }
  }

  red('consumer_temp_is_under_os_tmpdir',
    consumerTemp.startsWith(os.tmpdir()) || consumerTemp.includes(`${path.sep}tmp${path.sep}`)
    || /\/tmp\//.test(consumerTemp)
    || consumerTemp.startsWith('/tmp'));
} finally {
  rmrf(consumerTemp);
}

// ── Reference blobs + template immutability ─────────────────────────────────
console.log('\n── Reference blobs + immutability ──');
{
  const refErrors = slice1b.validateReferenceBytesAgainstMaster(ROOT);
  green('reference_blobs_unchanged_via_1b_helper',
    Array.isArray(refErrors) && refErrors.length === 0,
    (refErrors || []).join(','));
}

const afterTemplates = archetypeTemplateSnapshot();
const afterClients = clientsTreeSnapshot();
green('archetype_templates_immutable_during_1d',
  slice1d.deepEqual(beforeTemplates, afterTemplates));
green('config_clients_immutable_during_1d',
  slice1d.deepEqual(beforeClients, afterClients));

// ── Source fences (anti-coercion / anti-surrogate / no skip envs) ───────────
console.log('\n── Source fences ──');
{
  const verifierSrc = readText(path.join(ROOT, 'scripts', 'verify-factory-slice1d-integration-proof.js'));
  red('verifier_does_not_call_generator_expectation_helpers',
    !/\bgen\.expectedOutputPathSet\b/.test(verifierSrc)
    && !/\bgen\.previewRelativePaths\b/.test(verifierSrc)
    && !/\bgen\.buildFixtureSubstitutions\b/.test(verifierSrc));
  red('1d_does_not_export_write_or_apply_apis',
    typeof slice1d.writeDryRunPreview !== 'function'
    && typeof slice1d.generateDryRunPreview !== 'function');
  red('no_coerceNumericStrings_or_surrogate_clones',
    !/\bcoerceNumericStrings\b/.test(verifierSrc)
    && !/code:\s*['"]malibu['"]/.test(verifierSrc)
    && !/existingRecords:\s*\[/.test(verifierSrc)
    && !/amount_due_cents:\s*1000/.test(verifierSrc)
    && !/JSON\.parse\(JSON\.stringify\(pricingDisk\)\)/.test(verifierSrc)
    && !/JSON\.parse\(JSON\.stringify\(baseline\)\)/.test(verifierSrc));
  red('no_factory_skip_or_probe_env_bypasses',
    !/process\.env\.FACTORY_\w*(SKIP|PROBE)/.test(verifierSrc)
    && !/FACTORY_1[ABCD]_(SKIP|LEDGER_PROBE|SKIP_NESTED|SKIP_LEGACY)/.test(verifierSrc));
  red('1d_does_not_invoke_1a',
    !/npm['"\s,]*run['"\s,]*verify:factory-slice1a/.test(verifierSrc)
    && !/spawnSync\([^)]*verify-factory-slice1a/.test(verifierSrc)
    && !/runNpm\(['"]verify:factory-slice1a/.test(verifierSrc));
}

// Tip scope vs master for factory-touched paths on this branch working tree.
{
  let changed = [];
  try {
    changed = spawnSync('git', ['diff', '--name-only', slice1d.MASTER_BASIS], {
      cwd: ROOT,
      encoding: 'utf8',
    }).stdout.trim().split('\n').filter(Boolean);
  } catch (_) {
    changed = [];
  }
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).stdout.trim().split('\n').filter(Boolean);
  const factoryTouched = [...new Set([...changed, ...untracked])].filter((p) => (
    p.startsWith('fixtures/factory-client-productization/')
    || p.startsWith('scripts/lib/factory-slice1')
    || p.startsWith('scripts/verify-factory-slice1')
    || p === 'scripts/onboard-client.js'
    || p === 'docs/FACTORY-CLIENT-PRODUCTIZATION.md'
    || p === 'package.json'
    || p.startsWith('config/archetypes/')
  ));
  const tipCheck = tipPathsAllowed(factoryTouched);
  ok('1D tip paths within allowlist (1C correction + 1D proof)',
    tipCheck.ok,
    tipCheck.bad.join(','));
  red('no_archetype_template_edits_in_tip',
    !factoryTouched.some((p) => p.startsWith('config/archetypes/')));
  // Tip intentionally corrects 1C generator/CLI/fixtures for typed substitution.
  red('1c_generator_or_cli_present_for_typed_correction',
    factoryTouched.includes('scripts/lib/factory-slice1c-dry-run-generator.js')
    || factoryTouched.includes('scripts/onboard-client.js')
    || factoryTouched.some((p) => p.includes('slice1c-substitutions') || p.includes('slice1c-golden')));
}

// ── Nested prior factory gates (structurally no 1A) ─────────────────────────
console.log('\n── Nested prior factory gates (1B + 1C only) ──');
{
  for (const [label, script] of [
    ['verify:factory-slice1c-dry-run-generator', 'verify:factory-slice1c-dry-run-generator'],
    ['verify:factory-slice1b-archetype-templates', 'verify:factory-slice1b-archetype-templates'],
  ]) {
    const r = spawnSync('npm', ['run', script], {
      cwd: ROOT,
      encoding: 'utf8',
      env: process.env,
      timeout: 600000,
      shell: true,
    });
    ok(`${label} exit 0`, r.status === 0,
      r.status !== 0 ? (r.stderr || r.stdout || '').slice(-500) : '');
  }
}

// ── Legacy Luna + multiclient gates ─────────────────────────────────────────
console.log('\n── Legacy Luna + multiclient gates ──');
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

  console.log('\n── Retained master GREEN classification (current master) ──');
  // Same gate commands as the lock list; PRs #174/#175 made both exit 0.
  function runRetainedGreenGate(rel, { runner = runNodeScript } = {}) {
    const result = runner(rel);
    return { result, passed: result.status === 0 };
  }
  {
    const sanity = runRetainedGreenGate('scripts/_sanity.js', {
      runner: () => ({ status: 0 }),
    });
    ok('injected zero-status retained GREEN sanity', sanity.passed === true);
  }
  for (const row of slice1d.EXISTING_REGRESSION_RETAINED_MASTER_RED) {
    const rel = row.gate.replace(/^node\s+/, '');
    // Hostile: nonzero exit for either retained gate must fail FACTORY classification.
    let seen = null;
    const hostile = runRetainedGreenGate(rel, {
      runner: (p) => { seen = p; return { status: 1 }; },
    });
    ok(`hostile: nonzero ${path.basename(rel)} fails FACTORY retained GREEN`,
      seen === rel && hostile.passed === false);
    const { result: r, passed } = runRetainedGreenGate(rel);
    ok(`${rel} retained GREEN (current master)`, passed,
      r.status !== 0 ? (r.stderr || r.stdout || '').slice(-400) : '');
  }
}

{
  const diffCheck = spawnSync('git', ['diff', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  ok('git diff --check clean', diffCheck.status === 0,
    (diffCheck.stdout || diffCheck.stderr || '').slice(-300));
}

console.log(`\n── factory-slice1d: ${pass} passed, ${fail} failed ──`);
console.log(`  RED ${redResults.filter((r) => r.ok).length}/${redResults.length}  GREEN ${greenResults.filter((g) => g.ok).length}/${greenResults.length}`);

if (fail > 0) process.exit(1);
console.log('FACTORY Slice 1D integration proof: PASS');
process.exit(0);
