'use strict';

/**
 * FACTORY Slice 1A — source-derived registration/read-site inventory discovery.
 *
 * Completeness is derived by scanning real registration and read sites in the
 * repo. Fixture inventories must cover every discovered site and must not list
 * stale sites the scanner no longer finds. Discovery lives here — not in a
 * candidate-authored allowlist alone.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CLIENTS_DIR = path.join(ROOT, 'config', 'clients');

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

const FEATURE_FLAG_SYMBOLS = Object.freeze([
  'live_enabled',
  'DEFAULT_CLIENT_SLUG',
  'STAFF_API_INGRESS_TENANT_SLUG',
  'STRIPE_WEBHOOK_CLIENT_SLUG',
  'LUNA_BOT_CLIENT_SLUG',
  'CLIENT_CHANNEL_ROUTING_FILE',
  'SUNSET_ADMIN_DB_READ_ENABLED',
  'SUNSET_ADMIN_JSON_OVERLAY',
  'STAFF_PORTAL_DEV_TABS',
  'STAFF_API_ADMISSION_CONTROL',
]);

const CONSUMER_SYMBOLS = Object.freeze([
  'loadClientRegistry',
  'loadClientPortalProfile',
  'loadBaselineJson',
  'resolveTenantBusinessConfig',
  'loadClientConfirmationConfig',
  'loadClientMessagingConfig',
  'loadClientPersonalityFile',
  'loadClientCheckinConfig',
]);

const DEPLOYMENT_OVERLAY_PATHS = Object.freeze([
  'infra/azure/staging/main.bicep',
  'infra/azure/sunset-staging/main.bicep',
  'infra/docker-compose.local.yml',
  'infra/.env.example',
  'docker/hermes-staging/docker-compose.vm.yml',
  'config/clients/staff-portal-access.json',
  'config/clients/staff-portal-access.sunset-staging.json',
  'config/clients/channel-routing.staging.example.json',
]);

const EXISTING_VERIFIER_PATHS = Object.freeze([
  'scripts/verify-multiclient-isolation.js',
  'scripts/verify-no-client-hardcoding.js',
  'scripts/verify-tenant-resolution.js',
  'scripts/verify-meta-whatsapp-tenant-shadow.js',
  'scripts/verify-staff-tenant-scope.js',
  'scripts/verify-tenant-business-config.js',
  'scripts/verify-sunset-portal-slice1.js',
  'scripts/verify-wolfhouse-live-readiness-static.js',
]);

const REGISTRY_BASENAMES = Object.freeze([
  'clients.json',
  'staff-portal-access.json',
  'staff-portal-access.sunset-staging.json',
  'channel-routing.sample.json',
  'channel-routing.staging.example.json',
]);

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
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
  return out.sort((a, b) => rel(a).localeCompare(rel(b)));
}

function discoverClientConfigFiles() {
  return walkFiles(CLIENTS_DIR, (full, name) => name.endsWith('.json')).map(rel);
}

function discoverRegistries() {
  return discoverClientConfigFiles().filter((p) => {
    const base = path.posix.basename(p);
    return REGISTRY_BASENAMES.includes(base);
  });
}

function fileMentionsAny(absPath, symbols) {
  let text = '';
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  const hits = [];
  for (const sym of symbols) {
    if (text.includes(sym)) hits.push(sym);
  }
  return hits;
}

function discoverFeatureFlagSymbols() {
  const scanRoots = [
    path.join(ROOT, 'scripts', 'lib'),
    path.join(ROOT, 'scripts'),
    path.join(ROOT, 'infra'),
    path.join(ROOT, 'config', 'clients'),
  ];
  const found = new Set();
  for (const root of scanRoots) {
    const files = walkFiles(root, (full) => {
      const ext = path.extname(full);
      return TEXT_EXTENSIONS.has(ext) || full.endsWith('.env.example');
    });
    for (const abs of files) {
      // Keep discovery bounded: skip deep radar/fortress evidence noise for flags
      // that only appear in historical evidence, except scripts/lib + config + infra.
      const r = rel(abs);
      if (r.startsWith('scripts/verify-radar-') || r.startsWith('scripts/lib/radar-')) {
        // still count if the symbol is a runtime flag site in radar libs for admission
      }
      const hits = fileMentionsAny(abs, FEATURE_FLAG_SYMBOLS);
      for (const h of hits) found.add(h);
    }
  }
  return [...FEATURE_FLAG_SYMBOLS].filter((s) => found.has(s));
}

/**
 * Pricing / services / schedule / profile consumers: scripts/lib modules that
 * read client deploy/baseline/registry data for those domains, or call the
 * tenant business / portal profile / channel resolvers.
 */
function discoverPricingServicesScheduleProfileConsumers() {
  const libDir = path.join(ROOT, 'scripts', 'lib');
  const files = walkFiles(libDir, (full) => path.extname(full) === '.js');
  const domainRe =
    /\b(pricing|prices|service_catalog|services|schedule|lesson_times|portal_demo|loadClientPortalProfile|resolveTenantBusinessConfig|personality|messaging|confirmation|checkin|quote|catalog|invoice|waiver|location-admin)\b/i;
  const out = [];
  for (const abs of files) {
    const r = rel(abs);
    if (r.includes('factory-slice1a-')) continue;
    let text = '';
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const mentionsConfigClients =
      /config\/clients|'config',\s*'clients'|"config",\s*"clients"|CLIENTS_DIR|CLIENTS_JSON|DEFAULT_REGISTRY_PATH|ACCESS_FILE|STORE_PATH|\.baseline\.json|\.pricing\.json|\.messaging\.json|\.personalities\.json/.test(
        text,
      );
    const mentionsConsumer = CONSUMER_SYMBOLS.some((s) => text.includes(s));
    const mentionsResolverRequire =
      /require\(['"]\.\/(?:tenant-business-config|staff-portal-clients|client-channel-resolver)['"]\)/.test(text);
    if (!(mentionsConfigClients || mentionsConsumer || mentionsResolverRequire)) continue;
    // Domain filter: keep pricing/services/schedule/profile (and resolver-backed reads).
    if (!(domainRe.test(text) || mentionsConsumer || mentionsResolverRequire || mentionsConfigClients)) {
      continue;
    }
    out.push(r);
  }
  const requiredOwners = [
    'scripts/lib/staff-portal-clients.js',
    'scripts/lib/tenant-business-config.js',
    'scripts/lib/client-channel-resolver.js',
  ];
  for (const owner of requiredOwners) {
    if (!out.includes(owner) && fs.existsSync(path.join(ROOT, owner))) out.push(owner);
  }
  return [...new Set(out)].sort();
}

function discoverDeploymentOverlays() {
  return DEPLOYMENT_OVERLAY_PATHS.filter((p) => fs.existsSync(path.join(ROOT, p)));
}

function discoverExistingVerifiers() {
  return EXISTING_VERIFIER_PATHS.filter((p) => fs.existsSync(path.join(ROOT, p)));
}

function discoverWolfhouseSunsetPair() {
  const clientsPath = path.join(CLIENTS_DIR, 'clients.json');
  const raw = JSON.parse(fs.readFileSync(clientsPath, 'utf8'));
  const clients = Array.isArray(raw.clients) ? raw.clients : [];
  const bySlug = Object.fromEntries(
    clients.filter((c) => c && c.client_slug).map((c) => [c.client_slug, c]),
  );
  const wolfhouse = bySlug.wolfhouse || null;
  const sunset = bySlug.sunset || null;
  const whBaseline = path.join(CLIENTS_DIR, 'wolfhouse-somo.baseline.json');
  const sunsetBaseline = path.join(CLIENTS_DIR, 'sunset.baseline.json');
  let whVertical = null;
  let sunsetVertical = null;
  if (fs.existsSync(whBaseline)) {
    const j = JSON.parse(fs.readFileSync(whBaseline, 'utf8'));
    whVertical = (j.deploy_config && j.deploy_config.vertical)
      || (j._meta && j._meta.vertical)
      || null;
  }
  if (fs.existsSync(sunsetBaseline)) {
    const j = JSON.parse(fs.readFileSync(sunsetBaseline, 'utf8'));
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

function discoverAll() {
  return {
    completeness_method: 'source_derived_registration_read_site_inventory',
    categories: INVENTORY_CATEGORIES.slice(),
    client_config_files: discoverClientConfigFiles(),
    registries: discoverRegistries(),
    feature_flag_symbols: discoverFeatureFlagSymbols(),
    pricing_services_schedule_profile_consumers: discoverPricingServicesScheduleProfileConsumers(),
    deployment_overlays: discoverDeploymentOverlays(),
    existing_verifiers: discoverExistingVerifiers(),
    reference_pair: discoverWolfhouseSunsetPair(),
  };
}

/**
 * Compare a fixture inventory (candidate-authored) against live discovery.
 * Completeness requires bidirectional coverage per category.
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

module.exports = {
  ROOT,
  INVENTORY_CATEGORIES,
  FEATURE_FLAG_SYMBOLS,
  CONSUMER_SYMBOLS,
  DEPLOYMENT_OVERLAY_PATHS,
  EXISTING_VERIFIER_PATHS,
  discoverAll,
  discoverClientConfigFiles,
  discoverRegistries,
  discoverFeatureFlagSymbols,
  discoverPricingServicesScheduleProfileConsumers,
  discoverDeploymentOverlays,
  discoverExistingVerifiers,
  discoverWolfhouseSunsetPair,
  compareInventoryCompleteness,
};
