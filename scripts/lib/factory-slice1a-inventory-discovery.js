'use strict';

/**
 * FACTORY Slice 1A — source-derived registration/read-site inventory discovery.
 *
 * Completeness is derived by enumerating real registration and read sites in the
 * repo (or an injected temporary source root). Fixture inventories must match
 * discovery bidirectionally. Locked exclusions filter justified noise only —
 * they are never the expected inventory.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.join(__dirname, '..', '..');

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'tmp',
  'coverage',
  'dist',
  'build',
  '_work',
  'agent-transcripts',
]);

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.bicep', '.md', '.example',
]);

/** Categories the fixture inventory must cover 1:1 with discovery. */
const INVENTORY_CATEGORIES = Object.freeze([
  'client_config_files',
  'registries',
  'feature_flag_symbols',
  'pricing_services_schedule_profile_consumers',
  'deployment_overlays',
  'existing_verifiers',
]);

/**
 * Justified exclusions (noise / self / historical slice verifiers).
 * Never used as the expected inventory — only subtracted after discovery.
 */
const LOCKED_EXCLUSIONS = Object.freeze({
  /** Self modules must not appear as productization consumers/verifiers. */
  path_substrings: Object.freeze([
    'factory-slice1a-',
  ]),
  /** Historical program verifiers mention client paths without being FACTORY inventory. */
  verifier_path_prefixes: Object.freeze([
    'scripts/verify-radar-',
    'scripts/verify-fortress-',
    'scripts/verify-foundation-',
  ]),
  /** Flag-scan skip: historical evidence/libs that only name flags in freeze text. */
  feature_flag_path_prefixes: Object.freeze([
    'scripts/verify-radar-',
    'scripts/verify-fortress-',
    'scripts/verify-foundation-',
    'scripts/lib/radar-',
    'scripts/lib/fortress-',
    'scripts/lib/foundation-',
    'fixtures/',
    'docs/',
  ]),
});

/** Loader modules whose require()/import counts as an aliased/wrapped acquisition. */
const LOADER_MODULE_BASENAMES = Object.freeze([
  'staff-portal-clients',
  'tenant-business-config',
  'client-channel-resolver',
]);

/** Env/feature symbols recognized when read in source (classifier, not inventory). */
const FEATURE_FLAG_NAME_RE = /^(?:DEFAULT_CLIENT_SLUG|STAFF_API_INGRESS_TENANT_SLUG|STRIPE_WEBHOOK_CLIENT_SLUG|LUNA_BOT_CLIENT_SLUG|CLIENT_CHANNEL_ROUTING_FILE|SUNSET_ADMIN_[A-Z0-9_]+|STAFF_PORTAL_DEV_TABS|STAFF_API_ADMISSION_CONTROL)$/;

function rel(root, p) {
  return path.relative(root, p).split(path.sep).join('/');
}

function isExcludedPath(relPath, prefixes, substrings) {
  const r = String(relPath || '');
  if (substrings && substrings.some((s) => r.includes(s))) return true;
  if (prefixes && prefixes.some((p) => r.startsWith(p))) return true;
  return false;
}

function walkFiles(startAbs, filterFn) {
  const out = [];
  if (!fs.existsSync(startAbs)) return out;
  const stack = [startAbs];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.') && ent.name !== '.env.example') continue;
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (filterFn(full, ent.name)) out.push(full);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function readText(absPath) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return '';
  }
}

function isRegistryBasename(name) {
  if (name === 'clients.json') return true;
  if (/^staff-portal-access(?:\..+)?\.json$/.test(name)) return true;
  if (/^channel-routing(?:\..+)?\.json$/.test(name)) return true;
  return false;
}

function isOverlayConfigBasename(name) {
  if (/^staff-portal-access(?:\..+)?\.json$/.test(name)) return true;
  if (/^channel-routing\..+\.json$/.test(name)) return true;
  return false;
}

function textAcquiresConfigClients(text) {
  if (!text) return false;
  if (/config\/clients/.test(text)) return true;
  if (/\bCLIENTS_DIR\b/.test(text)) return true;
  if (/\bCLIENTS_JSON\b/.test(text)) return true;
  if (/\bDEFAULT_REGISTRY_PATH\b/.test(text)) return true;
  if (/\bACCESS_FILE\b/.test(text)) return true;
  if (/\bDEFAULT_CHANNEL_CONFIG_PATH\b/.test(text)) return true;
  // path.join(..., 'config', 'clients' ...) or path.join(..., 'clients', ...)
  if (/path\.join\([^;]{0,200}['"]clients['"]/.test(text)) return true;
  if (/['"]config['"]\s*,\s*['"]clients['"]/.test(text)) return true;
  // Directory enumeration of personalities / baselines under clients
  if (/readdir(?:Sync)?\([^)]*CLIENTS_DIR/.test(text)) return true;
  if (/\.personalities\.json/.test(text) && /clients/.test(text)) return true;
  if (/\$\{[^}]+\}\.baseline\.json/.test(text) || /`[^`]*\$\{[^}]+\}[^`]*\.baseline\.json`/.test(text)) {
    return true;
  }
  // Loader imports / aliases / wrappers
  for (const mod of LOADER_MODULE_BASENAMES) {
    const re = new RegExp(
      String.raw`require\(['"](?:\.[./]*|[^'"]*/)?(?:${mod})['"]\)|from ['"](?:\.[./]*|[^'"]*/)?(?:${mod})['"]`,
    );
    if (re.test(text)) return true;
  }
  if (/\b(?:loadClientRegistry|loadClientPortalProfile|loadBaselineJson|resolveTenantBusinessConfig|loadClientConfirmationConfig|loadClientMessagingConfig|loadClientPersonalityFile|loadClientCheckinConfig)\b/.test(text)) {
    return true;
  }
  return false;
}

function extractFeatureFlagSymbols(text) {
  const found = new Set();
  if (!text) return found;
  if (/\blive_enabled\b/.test(text)) found.add('live_enabled');
  const envRe = /process\.env\.([A-Z][A-Z0-9_]*)/g;
  let m;
  while ((m = envRe.exec(text))) {
    if (FEATURE_FLAG_NAME_RE.test(m[1])) found.add(m[1]);
  }
  // Bicep / env.example / comments: NAME: '...' or name: 'FLAG'
  const namedRe = /\b([A-Z][A-Z0-9_]{3,})\b/g;
  while ((m = namedRe.exec(text))) {
    if (FEATURE_FLAG_NAME_RE.test(m[1])) found.add(m[1]);
  }
  return found;
}

function discoverClientConfigFiles(root) {
  const clientsDir = path.join(root, 'config', 'clients');
  return walkFiles(clientsDir, (_full, name) => name.endsWith('.json')).map((p) => rel(root, p));
}

/**
 * Registries: config/clients JSON files classified as registry/routing/access
 * maps by basename convention, plus any such basename referenced from source.
 */
function discoverRegistries(root) {
  const onDisk = new Set(
    discoverClientConfigFiles(root).filter((p) => isRegistryBasename(path.posix.basename(p))),
  );

  // Source-referenced registry basenames under config/clients
  const scanRoots = [
    path.join(root, 'scripts'),
    path.join(root, 'infra'),
    path.join(root, 'docker'),
    path.join(root, 'config', 'clients'),
  ];
  const referenced = new Set();
  for (const scanRoot of scanRoots) {
    for (const abs of walkFiles(scanRoot, (full) => {
      const ext = path.extname(full);
      return TEXT_EXTENSIONS.has(ext) || full.endsWith('.env.example');
    })) {
      const r = rel(root, abs);
      if (isExcludedPath(r, null, LOCKED_EXCLUSIONS.path_substrings)) continue;
      const text = readText(abs);
      const fileRe = /(?:config\/clients\/)?(clients\.json|staff-portal-access(?:\.[A-Za-z0-9_-]+)?\.json|channel-routing(?:\.[A-Za-z0-9_-]+)?\.json)/g;
      let m;
      while ((m = fileRe.exec(text))) {
        referenced.add(`config/clients/${m[1]}`);
      }
    }
  }

  for (const p of referenced) {
    if (fs.existsSync(path.join(root, p))) onDisk.add(p);
  }
  return [...onDisk].sort();
}

function discoverFeatureFlagSymbols(root) {
  const scanRoots = [
    path.join(root, 'scripts'),
    path.join(root, 'infra'),
    path.join(root, 'docker'),
    path.join(root, 'config', 'clients'),
  ];
  const found = new Set();
  for (const scanRoot of scanRoots) {
    for (const abs of walkFiles(scanRoot, (full) => {
      const ext = path.extname(full);
      return TEXT_EXTENSIONS.has(ext) || full.endsWith('.env.example');
    })) {
      const r = rel(root, abs);
      if (isExcludedPath(r, LOCKED_EXCLUSIONS.feature_flag_path_prefixes, LOCKED_EXCLUSIONS.path_substrings)) {
        continue;
      }
      for (const sym of extractFeatureFlagSymbols(readText(abs))) found.add(sym);
    }
  }
  return [...found].sort();
}

/**
 * Acquisition sites for config/clients (pricing/services/schedule/profile and
 * broader loaders): scripts/lib, staff-query-api, check-i18n personality
 * enumeration, and other non-verifier scripts that read via fs/path/dynamic
 * basename/readdir/loader require.
 */
function discoverPricingServicesScheduleProfileConsumers(root) {
  const out = new Set();
  const scriptsDir = path.join(root, 'scripts');
  const files = walkFiles(scriptsDir, (full) => path.extname(full) === '.js');

  for (const abs of files) {
    const r = rel(root, abs);
    if (isExcludedPath(r, null, LOCKED_EXCLUSIONS.path_substrings)) continue;
    // Verifier files belong in existing_verifiers, not consumer inventory.
    if (/^scripts\/verify-/.test(r)) continue;
    const text = readText(abs);
    if (!textAcquiresConfigClients(text)) continue;
    out.add(r);
  }
  return [...out].sort();
}

function isTenantDeployOverlayPath(relPath, text) {
  const base = path.posix.basename(relPath);
  if (isOverlayConfigBasename(base)) return true;
  if (relPath === 'infra/.env.example') return true;
  // Compose overlays that bind Hermes/staff to a tenant deploy.
  if (/docker-compose/.test(base) && /hermes|DEFAULT_CLIENT_SLUG|STAFF_API_INGRESS|staff-staging|sunset-staging|wolfhouse|sunset/.test(text)) {
    return true;
  }
  // Primary Azure tenant staging entrypoints only (not satellite role/budget modules).
  if (/^infra\/azure\/[^/]+\/main\.bicep$/.test(relPath)
    && /STAFF_API_INGRESS_TENANT_SLUG|DEFAULT_CLIENT_SLUG|STRIPE_WEBHOOK_CLIENT_SLUG|LUNA_BOT_CLIENT_SLUG/.test(text)) {
    return true;
  }
  return false;
}

/**
 * Deployment overlays: staging Bicep/compose/env that configure tenant deploy,
 * plus client access/routing overlay JSON files on disk.
 */
function discoverDeploymentOverlays(root) {
  const out = new Set();

  for (const p of discoverClientConfigFiles(root)) {
    if (isOverlayConfigBasename(path.posix.basename(p))) out.add(p);
  }

  const infraRoots = [
    path.join(root, 'infra'),
    path.join(root, 'docker'),
  ];
  for (const infraRoot of infraRoots) {
    for (const abs of walkFiles(infraRoot, (full, name) => {
      const ext = path.extname(full);
      if (name === '.env.example' || full.endsWith('.env.example')) return true;
      if (ext === '.bicep') return true;
      if (ext === '.yml' || ext === '.yaml') return /docker-compose|compose/.test(name);
      return false;
    })) {
      const r = rel(root, abs);
      if (isTenantDeployOverlayPath(r, readText(abs))) out.add(r);
    }
  }
  return [...out].sort();
}

/**
 * Classifier: multiclient / tenant-config / portal-slice1 / live-readiness gates.
 * Name patterns classify purpose; inventory is whatever matching files exist.
 */
function isClientProductizationVerifier(relPath, text, fromGateScript) {
  if (fromGateScript) return true;
  if (/^scripts\/verify-(?:multiclient-isolation|no-client-hardcoding|tenant-resolution|meta-whatsapp-tenant-shadow|staff-tenant-scope|tenant-business-config)\.js$/.test(relPath)) {
    return true;
  }
  if (/^scripts\/verify-(?:sunset-portal-slice1|wolfhouse-live-readiness-static)\.js$/.test(relPath)
    && textAcquiresConfigClients(text)) {
    return true;
  }
  return false;
}

function packageGateScriptKeys(scripts) {
  const keys = new Set();
  for (const key of Object.keys(scripts || {})) {
    if (!/^verify:/.test(key)) continue;
    if (/^verify:(?:multiclient|tenant-business-config|tenant-resolution|no-client|meta-whatsapp|staff-tenant)\b/.test(key)) {
      keys.add(key);
    }
  }
  return keys;
}

/**
 * Existing verifiers: package.json gate registrations + classify verify-*.js
 * files (minus locked historical program prefixes).
 */
function discoverExistingVerifiers(root) {
  const out = new Set();
  const gateRegistered = new Set();
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    let pkg;
    try {
      pkg = JSON.parse(readText(pkgPath));
    } catch {
      pkg = null;
    }
    const scripts = (pkg && pkg.scripts) || {};
    for (const key of packageGateScriptKeys(scripts)) {
      const re = /node\s+(scripts\/verify-[A-Za-z0-9._-]+\.js)/g;
      let m;
      while ((m = re.exec(String(scripts[key])))) {
        gateRegistered.add(m[1]);
      }
    }
  }

  const verifyFiles = walkFiles(path.join(root, 'scripts'), (full, name) => (
    name.startsWith('verify-') && name.endsWith('.js')
  ));
  for (const abs of verifyFiles) {
    const r = rel(root, abs);
    if (isExcludedPath(r, LOCKED_EXCLUSIONS.verifier_path_prefixes, LOCKED_EXCLUSIONS.path_substrings)) {
      continue;
    }
    const text = readText(abs);
    if (isClientProductizationVerifier(r, text, gateRegistered.has(r))) {
      out.add(r);
    }
  }

  // Gate-registered paths that exist but were not walked (defensive).
  for (const p of gateRegistered) {
    if (isExcludedPath(p, LOCKED_EXCLUSIONS.verifier_path_prefixes, LOCKED_EXCLUSIONS.path_substrings)) {
      continue;
    }
    if (fs.existsSync(path.join(root, p))) out.add(p);
  }

  return [...out].filter((p) => fs.existsSync(path.join(root, p))).sort();
}

function discoverWolfhouseSunsetPair(root) {
  const clientsPath = path.join(root, 'config', 'clients', 'clients.json');
  if (!fs.existsSync(clientsPath)) {
    return { wolfhouse: null, sunset: null };
  }
  const raw = JSON.parse(readText(clientsPath));
  const clients = Array.isArray(raw.clients) ? raw.clients : [];
  const bySlug = Object.fromEntries(
    clients.filter((c) => c && c.client_slug).map((c) => [c.client_slug, c]),
  );
  const wolfhouse = bySlug.wolfhouse || null;
  const sunset = bySlug.sunset || null;
  const whBaseline = path.join(root, 'config', 'clients', 'wolfhouse-somo.baseline.json');
  const sunsetBaseline = path.join(root, 'config', 'clients', 'sunset.baseline.json');
  let whVertical = null;
  let sunsetVertical = null;
  if (fs.existsSync(whBaseline)) {
    const j = JSON.parse(readText(whBaseline));
    whVertical = (j.deploy_config && j.deploy_config.vertical)
      || (j._meta && j._meta.vertical)
      || null;
  }
  if (fs.existsSync(sunsetBaseline)) {
    const j = JSON.parse(readText(sunsetBaseline));
    sunsetVertical = (j.deploy_config && j.deploy_config.vertical)
      || (j._meta && j._meta.vertical)
      || null;
  }
  return {
    wolfhouse: wolfhouse && {
      client_slug: wolfhouse.client_slug,
      live_enabled: wolfhouse.live_enabled === true,
      location_ids: (wolfhouse.locations || []).map((l) => l.location_id),
      baseline: 'config/clients/wolfhouse-somo.baseline.json',
      vertical: whVertical,
    },
    sunset: sunset && {
      client_slug: sunset.client_slug,
      live_enabled: sunset.live_enabled === true,
      location_ids: (sunset.locations || []).map((l) => l.location_id),
      baseline: 'config/clients/sunset.baseline.json',
      vertical: sunsetVertical,
    },
  };
}

function discoverAll(options) {
  const root = (options && options.root) || DEFAULT_ROOT;
  return {
    completeness_method: 'source_derived_registration_read_site_inventory',
    categories: INVENTORY_CATEGORIES.slice(),
    client_config_files: discoverClientConfigFiles(root),
    registries: discoverRegistries(root),
    feature_flag_symbols: discoverFeatureFlagSymbols(root),
    pricing_services_schedule_profile_consumers: discoverPricingServicesScheduleProfileConsumers(root),
    deployment_overlays: discoverDeploymentOverlays(root),
    existing_verifiers: discoverExistingVerifiers(root),
    reference_pair: discoverWolfhouseSunsetPair(root),
    locked_exclusions: {
      path_substrings: LOCKED_EXCLUSIONS.path_substrings.slice(),
      verifier_path_prefixes: LOCKED_EXCLUSIONS.verifier_path_prefixes.slice(),
      feature_flag_path_prefixes: LOCKED_EXCLUSIONS.feature_flag_path_prefixes.slice(),
    },
  };
}

/**
 * Compare a fixture inventory (candidate-authored) against live discovery.
 * Completeness requires exact bidirectional set equality per category.
 */
function compareInventoryCompleteness(fixtureInventory, discovered) {
  const errors = [];
  const details = {};
  for (const cat of INVENTORY_CATEGORIES) {
    const expected = Array.isArray(fixtureInventory && fixtureInventory[cat])
      ? fixtureInventory[cat].slice().sort()
      : null;
    const actual = Array.isArray(discovered[cat]) ? discovered[cat].slice().sort() : [];
    if (!expected) {
      errors.push(`missing_fixture_category:${cat}`);
      details[cat] = { missing_in_fixture: actual, stale_in_fixture: [] };
      continue;
    }
    const expSet = new Set(expected);
    const actSet = new Set(actual);
    const missingInFixture = actual.filter((x) => !expSet.has(x));
    const staleInFixture = expected.filter((x) => !actSet.has(x));
    details[cat] = { missing_in_fixture: missingInFixture, stale_in_fixture: staleInFixture };
    if (missingInFixture.length) errors.push(`incomplete_fixture:${cat}`);
    if (staleInFixture.length) errors.push(`stale_fixture:${cat}`);
  }
  return { ok: errors.length === 0, errors, details };
}

/**
 * Build a temporary source tree with adversarial registration/read sites for
 * RED proofs. Caller must rimraf the returned root when finished.
 */
function buildAdversarialTemporarySource(tmpRoot) {
  const write = (relPath, contents) => {
    const abs = path.join(tmpRoot, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents, 'utf8');
  };

  write('package.json', `${JSON.stringify({
    name: 'factory1a-adversarial',
    private: true,
    scripts: {
      // New verifier registration on the multiclient gate chain (source-derived).
      'verify:multiclient':
        'node scripts/verify-multiclient-isolation.js && node scripts/verify-adversarial-factory-client.js',
    },
  }, null, 2)}\n`);

  write('config/clients/clients.json', `${JSON.stringify({
    clients: [
      {
        client_slug: 'wolfhouse',
        live_enabled: false,
        locations: [{ location_id: 'wolfhouse-somo' }],
      },
      {
        client_slug: 'sunset',
        live_enabled: false,
        locations: [
          { location_id: 'sunset-somo' },
          { location_id: 'sunset-sardinero' },
        ],
      },
    ],
  }, null, 2)}\n`);

  write('config/clients/wolfhouse-somo.baseline.json', `${JSON.stringify({
    _meta: { client_slug: 'wolfhouse', vertical: 'lodging_surf_house' },
    deploy_config: { vertical: 'lodging_surf_house' },
  }, null, 2)}\n`);

  write('config/clients/sunset.baseline.json', `${JSON.stringify({
    _meta: { client_slug: 'sunset', vertical: 'surf_school_rentals' },
    deploy_config: { vertical: 'surf_school_rentals' },
  }, null, 2)}\n`);

  // New registry absent from a frozen fixture.
  write('config/clients/channel-routing.adversarial.json', `${JSON.stringify({ routes: [] }, null, 2)}\n`);
  write('config/clients/staff-portal-access.adversarial.json', `${JSON.stringify({ client_access: {} }, null, 2)}\n`);
  write('config/clients/wolfhouse-somo.personalities.json', `${JSON.stringify({ en: {}, es: {} }, null, 2)}\n`);

  // Loader + aliased/wrapped/dynamic consumers.
  write('scripts/lib/staff-portal-clients.js', `'use strict';
const fs = require('fs');
const path = require('path');
const CLIENTS_DIR = path.join(__dirname, '..', '..', 'config', 'clients');
function loadBaselineJson(slug) {
  return JSON.parse(fs.readFileSync(path.join(CLIENTS_DIR, slug + '.baseline.json'), 'utf8'));
}
module.exports = { loadBaselineJson, CLIENTS_DIR };
`);

  write('scripts/lib/adversarial-client-wrapper.js', `'use strict';
/** Aliased/wrapped loader consumer for FACTORY 1A RED. */
const portal = require('./staff-portal-clients');
const path = require('path');
const fs = require('fs');
function loadViaAlias(slug) {
  return portal.loadBaselineJson(slug);
}
function loadDynamic(slug) {
  const p = path.join(portal.CLIENTS_DIR, \`\${slug}.baseline.json\`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
module.exports = { loadViaAlias, loadDynamic };
`);

  write('scripts/staff-query-api.js', `'use strict';
const path = require('path');
const fs = require('fs');
function readClientBaseline(clientSlug) {
  const cfgPath = path.join(__dirname, '..', 'config', 'clients', \`\${clientSlug}.baseline.json\`);
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}
const FLAG = process.env.FACTORY_ADVERSARIAL_CLIENT_FLAG;
const INGRESS = process.env.STAFF_API_INGRESS_TENANT_SLUG;
module.exports = { readClientBaseline, FLAG, INGRESS };
`);

  write('scripts/check-i18n-guest-copy.js', `'use strict';
const fs = require('fs');
const path = require('path');
const CLIENTS_DIR = path.join(__dirname, '..', 'config', 'clients');
function enumeratePersonalities() {
  return fs.readdirSync(CLIENTS_DIR).filter((n) => n.endsWith('.personalities.json'));
}
module.exports = { enumeratePersonalities, CLIENTS_DIR };
`);

  // New feature-flag site (classifier-recognized symbol, new physical site).
  write('scripts/lib/adversarial-feature-flag.js', `'use strict';
function enabled(env) {
  return String((env || process.env).STAFF_API_ADMISSION_CONTROL || '') === '1';
}
module.exports = { enabled };
`);

  // New deployment overlay.
  write('infra/azure/adversarial-staging/main.bicep', `
param location string
// adversarial tenant overlay
var env = [
  { name: 'STAFF_API_INGRESS_TENANT_SLUG', value: 'adversarial' }
  { name: 'DEFAULT_CLIENT_SLUG', value: 'adversarial' }
]
`);

  // New verifier registration + file (gate-pack name class + package registration).
  write('scripts/verify-adversarial-factory-client.js', `'use strict';
const path = require('path');
const fs = require('fs');
const p = path.join(__dirname, '..', 'config', 'clients', 'clients.json');
if (!fs.existsSync(p)) process.exit(1);
console.log('adversarial ok');
`);

  write('scripts/verify-multiclient-isolation.js', `'use strict';
const path = require('path');
const fs = require('fs');
fs.readFileSync(path.join(__dirname, '..', 'config', 'clients', 'clients.json'), 'utf8');
console.log('ok');
`);

  return {
    root: tmpRoot,
    expected_new: {
      registries: [
        'config/clients/channel-routing.adversarial.json',
        'config/clients/staff-portal-access.adversarial.json',
      ],
      pricing_services_schedule_profile_consumers: [
        'scripts/check-i18n-guest-copy.js',
        'scripts/lib/adversarial-client-wrapper.js',
        'scripts/lib/staff-portal-clients.js',
        'scripts/staff-query-api.js',
      ],
      deployment_overlays: [
        'config/clients/channel-routing.adversarial.json',
        'config/clients/staff-portal-access.adversarial.json',
        'infra/azure/adversarial-staging/main.bicep',
      ],
      existing_verifiers: [
        'scripts/verify-adversarial-factory-client.js',
        'scripts/verify-multiclient-isolation.js',
      ],
      feature_flag_symbols: [
        'DEFAULT_CLIENT_SLUG',
        'STAFF_API_ADMISSION_CONTROL',
        'STAFF_API_INGRESS_TENANT_SLUG',
      ],
    },
  };
}

module.exports = {
  ROOT: DEFAULT_ROOT,
  INVENTORY_CATEGORIES,
  LOCKED_EXCLUSIONS,
  LOADER_MODULE_BASENAMES,
  FEATURE_FLAG_NAME_RE,
  discoverAll,
  discoverClientConfigFiles,
  discoverRegistries,
  discoverFeatureFlagSymbols,
  discoverPricingServicesScheduleProfileConsumers,
  discoverDeploymentOverlays,
  discoverExistingVerifiers,
  discoverWolfhouseSunsetPair,
  compareInventoryCompleteness,
  buildAdversarialTemporarySource,
  textAcquiresConfigClients,
};
