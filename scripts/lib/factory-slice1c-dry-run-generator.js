'use strict';

/**
 * FACTORY Slice 1C — deterministic disabled dry-run onboarding generator.
 *
 * Pure library: reads reviewed 1B templates under config/archetypes/, applies
 * substitutions, validates safety constraints, and returns canonical preview
 * bytes + manifest/hashes. Optional disk materialization writes via private
 * sibling staging + atomic no-replace publish into a nonexistent final
 * directory (exclusive creates; parent chain lstat/realpath safety; Linux
 * parent-directory fd anchor via O_DIRECTORY|O_NOFOLLOW + /proc/self/fd/<fd>).
 *
 * Disk-mode publish boundary (Linux/GNU only): the sole local subprocess is
 * `/usr/bin/mv --no-copy --no-clobber -T` spawned with an argument array (no
 * shell), `/proc/<pid>/fd/<fd>`-anchored publish paths (in-process ops keep
 * `/proc/self/fd/<fd>`), and closed/discarded stdio. Node `fs.rename` is not
 * used for publish — it can replace an empty final directory. Unavailable
 * exact executable/options fail closed.
 *
 * After every mv spawn outcome (ok / error / signal / nonzero), inspect
 * fd-anchored staging/final against the captured staged inode and track
 * ownership explicitly before returning: source gone + final same inode means
 * the generator owns final (remove it on bad spawn); source present means
 * remove staging only and preserve any external final; impossible/mismatched
 * state fails closed without deleting unowned paths. After post-publish hooks
 * and parent identity checks, re-read the fd-anchored exact output set and
 * verify every byte/hash against the precomputed preview before success.
 * Does not apply, write registries, touch config/clients, load runtime, open
 * DB/cloud/network, or materialize secrets. stdout emission is zero-write.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const slice1b = require('./factory-slice1b-archetype-templates');

/** Sole disk-mode publish executable (Linux/GNU coreutils). */
const GNU_MV_PATH = '/usr/bin/mv';
/** Fixed no-replace publish flags; never shell-interpolated. */
const GNU_MV_PUBLISH_ARGS = Object.freeze(['--no-copy', '--no-clobber', '-T']);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const SLICE = 'FACTORY-1C';
const BRANCH = 'factory/slice-1c-dry-run-generator';
const MASTER_BASIS = 'ce89a43ee1e2367a832255fec5ee4aefbfb4d2d8';
const OUTCOME_ID = '1C_deterministic_disabled_dry_run_generator';
const COMPLETION_EVIDENCE = '1C_deterministic_disabled_dry_run_generator';
const COMPLETION_REQUIRES = 'verify:factory-slice1c-dry-run-generator';

const ARCHETYPE_IDS = Object.freeze(['surf_house', 'surf_school_shop']);
const MODE_DRY_RUN = 'dry-run';
const ALLOWED_MODES = Object.freeze([MODE_DRY_RUN]);

const SLUG_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const PLACEHOLDER_RE = /^\{\{([A-Z0-9_]+)\}\}$/;
const EMBEDDED_PLACEHOLDER_RE = /\{\{([A-Z0-9_]+)\}\}/g;
const UNSAFE_PATH_RE = /(?:^|[\\/])\.\.(?:[\\/]|$)|[\\/]|\0/;

const DOC_FIELD_KEYS = Object.freeze([
  '_note',
  'notes',
  'purpose',
  'note',
]);

const REQUIRED_IDENTITY_TOKENS = Object.freeze({
  surf_house: Object.freeze([
    'CLIENT_SLUG',
    'CLIENT_NAME',
    'LOCATION_ID',
  ]),
  surf_school_shop: Object.freeze([
    'CLIENT_SLUG',
    'CLIENT_NAME',
    'LOCATION_ID_1',
    'LOCATION_ID_2',
    'LOCATION_NAME_1',
    'LOCATION_NAME_2',
  ]),
});

const GENERATED_FILE_KINDS = Object.freeze({
  surf_house: Object.freeze([
    'baseline',
    'pricing',
    'secrets_example',
    'registry_entry',
  ]),
  surf_school_shop: Object.freeze([
    'baseline',
    'secrets_example',
    'registry_entry',
  ]),
});

const TEMPLATE_SOURCE_FILES = Object.freeze({
  surf_house: Object.freeze([
    'baseline.template.json',
    'pricing.template.json',
    'secrets.example.template.json',
  ]),
  surf_school_shop: Object.freeze([
    'baseline.template.json',
    'secrets.example.template.json',
  ]),
});

const FORBIDDEN_OUTPUT_ROOTS = Object.freeze([
  'config/clients',
  'config/archetypes',
  'database',
  'infra',
  '.git',
]);

const ALLOWED_TIP_PATH_PREFIXES = Object.freeze([
  'docs/FACTORY-CLIENT-PRODUCTIZATION.md',
  'fixtures/factory-client-productization/',
  'scripts/lib/factory-slice1a-acceptance-contract.js',
  'scripts/lib/factory-slice1c-dry-run-generator.js',
  'scripts/verify-factory-slice1a-acceptance-contract.js',
  'scripts/verify-factory-slice1c-dry-run-generator.js',
  'scripts/onboard-client.js',
  'package.json',
  'package-lock.json',
]);

const PACKAGE_JSON_ALLOWED_SCRIPT_KEY = 'verify:factory-slice1c-dry-run-generator';
const PACKAGE_JSON_ALLOWED_SCRIPT_VALUE =
  'node scripts/verify-factory-slice1c-dry-run-generator.js';

const EXISTING_REGRESSION_GATES = Object.freeze([
  'npm run verify:factory-slice1b-archetype-templates',
  'npm run verify:factory-slice1a-acceptance-contract',
  'node scripts/verify-multiclient-isolation.js',
  'node scripts/verify-no-client-hardcoding.js',
  'node scripts/verify-tenant-resolution.js',
  'node scripts/verify-meta-whatsapp-tenant-shadow.js',
]);

const FORBIDDEN_CONTENT_PATTERNS = slice1b.FORBIDDEN_CONTENT_PATTERNS;

function thaw(value) {
  if (Array.isArray(value)) return value.map(thaw);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = thaw(value[key]);
    return out;
  }
  return value;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a == null || b == null) return a === b;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === 'object') {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (!deepEqual(ak, bk)) return false;
    for (const k of ak) {
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isDocFieldKey(key) {
  return typeof key === 'string' && DOC_FIELD_KEYS.includes(key);
}

function isStrictSlug(value) {
  return typeof value === 'string' && SLUG_RE.test(value) && value.length <= 64;
}

function sortedStringify(value) {
  return `${stableStringify(value, 2)}\n`;
}

function stableStringify(value, space) {
  return JSON.stringify(sortKeysDeep(value), null, space);
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

function scanForbiddenContent(text) {
  const hits = [];
  const blob = String(text || '');
  for (const row of FORBIDDEN_CONTENT_PATTERNS) {
    if (row.re.test(blob)) hits.push(row.id);
  }
  return hits;
}

function collectPlaceholders(node, options = {}) {
  const skipDoc = options.skipDoc !== false;
  const out = new Set();
  function walk(value, parentKey) {
    if (skipDoc && isDocFieldKey(parentKey)) return;
    if (typeof value === 'string') {
      const exact = PLACEHOLDER_RE.exec(value);
      if (exact) {
        out.add(exact[1]);
        return;
      }
      const re = new RegExp(EMBEDDED_PLACEHOLDER_RE.source, 'g');
      let m;
      while ((m = re.exec(value))) out.add(m[1]);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, parentKey);
      return;
    }
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        const keyExact = PLACEHOLDER_RE.exec(key);
        if (keyExact) out.add(keyExact[1]);
        walk(value[key], key);
      }
    }
  }
  walk(node, null);
  return [...out].sort();
}

function substituteString(str, substitutions, unresolved) {
  if (typeof str !== 'string') return str;
  const exact = PLACEHOLDER_RE.exec(str);
  if (exact) {
    const token = exact[1];
    if (!Object.prototype.hasOwnProperty.call(substitutions, token)) {
      unresolved.add(token);
      return str;
    }
    return substitutions[token];
  }
  return str.replace(new RegExp(EMBEDDED_PLACEHOLDER_RE.source, 'g'), (full, token) => {
    if (!Object.prototype.hasOwnProperty.call(substitutions, token)) {
      unresolved.add(token);
      return full;
    }
    return String(substitutions[token]);
  });
}

function substituteTree(node, substitutions, unresolved, parentKey) {
  if (isDocFieldKey(parentKey)) return node;
  if (typeof node === 'string') {
    return substituteString(node, substitutions, unresolved);
  }
  if (Array.isArray(node)) {
    return node.map((item) => substituteTree(item, substitutions, unresolved, parentKey));
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node)) {
      const keyExact = PLACEHOLDER_RE.exec(key);
      let nextKey = key;
      if (keyExact) {
        const token = keyExact[1];
        if (!Object.prototype.hasOwnProperty.call(substitutions, token)) {
          unresolved.add(token);
        } else {
          nextKey = String(substitutions[token]);
        }
      }
      if (Object.prototype.hasOwnProperty.call(out, nextKey)) {
        unresolved.add(`key_collision:${nextKey}`);
      }
      out[nextKey] = substituteTree(node[key], substitutions, unresolved, key);
    }
    return out;
  }
  return node;
}

function getPath(obj, dotted) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadExistingTenants(repoRoot) {
  const clientsPath = path.join(repoRoot, 'config', 'clients', 'clients.json');
  const clientsDoc = readJson(clientsPath);
  const clientSlugs = new Set();
  const locationIds = new Set();
  const locationOwners = new Map();
  for (const row of clientsDoc.clients || []) {
    if (row && row.client_slug) clientSlugs.add(row.client_slug);
    for (const loc of row.locations || []) {
      if (loc && loc.location_id) {
        locationIds.add(loc.location_id);
        locationOwners.set(loc.location_id, row.client_slug);
      }
    }
  }
  const clientsDir = path.join(repoRoot, 'config', 'clients');
  const baselineFiles = fs.readdirSync(clientsDir)
    .filter((name) => name.endsWith('.baseline.json'))
    .map((name) => name.replace(/\.baseline\.json$/, ''));
  for (const slug of baselineFiles) {
    // wolfhouse-somo is a location-scoped baseline filename; also record bare prefixes.
    clientSlugs.add(slug);
    if (slug.includes('-')) {
      clientSlugs.add(slug.split('-')[0]);
    }
  }
  return { clientSlugs, locationIds, locationOwners, clientsDoc };
}

function validateSlugValue(label, value, errors) {
  if (!isStrictSlug(value)) {
    errors.push(`${label}_invalid_slug:${value}`);
    return;
  }
  if (UNSAFE_PATH_RE.test(value)) {
    errors.push(`${label}_path_traversal:${value}`);
  }
}

function validateSubstitutionSafety(substitutions, errors) {
  for (const [token, raw] of Object.entries(substitutions)) {
    if (!/^[A-Z0-9_]+$/.test(token)) {
      errors.push(`substitution_token_invalid:${token}`);
      continue;
    }
    if (raw == null) {
      errors.push(`substitution_value_null:${token}`);
      continue;
    }
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (typeof raw === 'string' && UNSAFE_PATH_RE.test(raw) && /SLUG|LOCATION_ID|ROOM_ID|PACKAGE_CODE|SERVICE_|RENTAL_|LESSON_|BUNDLE_/.test(token)) {
      errors.push(`substitution_path_traversal:${token}`);
    }
    const forbidden = scanForbiddenContent(text);
    for (const id of forbidden) {
      errors.push(`substitution_forbidden:${token}:${id}`);
    }
  }
}

function assertEnablementFalse(baseline, archetypeId, errors) {
  const paths = slice1b.ENABLEMENT_FALSE_PATHS[archetypeId] || [];
  for (const dotted of paths) {
    const value = getPath(baseline, dotted);
    if (value !== false) errors.push(`enablement_not_false:${dotted}`);
  }
  const sendMode = getPath(baseline, 'confirmation.confirmation_send_mode');
  if (!slice1b.SEND_MODE_ALLOWED.includes(sendMode)) {
    errors.push(`confirmation_send_mode_not_safe:${sendMode}`);
  }
}

function previewRelativePaths(archetypeId, clientSlug) {
  const prefix = `preview/${clientSlug}`;
  const files = {
    baseline: `${prefix}.baseline.json`,
    secrets_example: `${prefix}.secrets.example.json`,
    registry_entry: `${prefix}.registry-entry.json`,
    manifest: 'dry-run-manifest.json',
  };
  if (archetypeId === 'surf_house') {
    files.pricing = `${prefix}.pricing.json`;
  }
  return files;
}

function expectedOutputPathSet(archetypeId, clientSlug) {
  const rel = previewRelativePaths(archetypeId, clientSlug);
  const set = [rel.manifest, rel.baseline, rel.secrets_example, rel.registry_entry];
  if (rel.pricing) set.push(rel.pricing);
  return set.sort();
}

function buildRegistryEntry(archetypeId, substitutions) {
  if (archetypeId === 'surf_house') {
    return {
      client_slug: substitutions.CLIENT_SLUG,
      display_name: substitutions.CLIENT_NAME,
      live_enabled: false,
      locations: [
        {
          location_id: substitutions.LOCATION_ID,
          display_name: substitutions.LOCATION_NAME
            || substitutions.CLIENT_NAME,
        },
      ],
    };
  }
  return {
    client_slug: substitutions.CLIENT_SLUG,
    display_name: substitutions.CLIENT_NAME,
    live_enabled: false,
    locations: [
      {
        location_id: substitutions.LOCATION_ID_1,
        display_name: substitutions.LOCATION_NAME_1,
      },
      {
        location_id: substitutions.LOCATION_ID_2,
        display_name: substitutions.LOCATION_NAME_2,
      },
    ],
  };
}

function loadArchetypeTemplates(repoRoot, archetypeId) {
  const dir = path.join(repoRoot, 'config', 'archetypes', archetypeId);
  const out = {
    baseline: readJson(path.join(dir, 'baseline.template.json')),
    secretsExample: readJson(path.join(dir, 'secrets.example.template.json')),
    pricing: null,
    templateHashes: {},
  };
  for (const name of TEMPLATE_SOURCE_FILES[archetypeId]) {
    const abs = path.join(dir, name);
    const bytes = fs.readFileSync(abs);
    out.templateHashes[name] = sha256Hex(bytes);
  }
  if (archetypeId === 'surf_house') {
    out.pricing = readJson(path.join(dir, 'pricing.template.json'));
  }
  return out;
}

/**
 * Pure dry-run generation. Reads templates + clients.json; returns bytes only.
 * Never writes. Never applies.
 *
 * @param {object} input
 * @param {string} input.repoRoot
 * @param {string} input.archetype
 * @param {string} input.mode
 * @param {object} input.substitutions map of TOKEN -> value (no {{ }})
 * @returns {{ ok: boolean, errors: string[], files?: object[], manifest?: object }}
 */
function generateDryRunPreview(input) {
  const errors = [];
  const repoRoot = input && input.repoRoot;
  const archetype = input && input.archetype;
  const mode = (input && input.mode) || MODE_DRY_RUN;
  const substitutionsIn = (input && input.substitutions) || {};

  if (!repoRoot || typeof repoRoot !== 'string') {
    return { ok: false, errors: ['repo_root_required'] };
  }
  if (!ARCHETYPE_IDS.includes(archetype)) {
    return { ok: false, errors: [`archetype_unsupported:${archetype}`] };
  }
  if (!ALLOWED_MODES.includes(mode)) {
    return { ok: false, errors: [`mode_unsupported:${mode}`] };
  }
  if (mode !== MODE_DRY_RUN) {
    return { ok: false, errors: ['apply_path_forbidden'] };
  }

  const substitutions = {};
  for (const [k, v] of Object.entries(substitutionsIn)) {
    const token = String(k).replace(/^\{\{/, '').replace(/\}\}$/, '');
    substitutions[token] = v;
  }

  validateSubstitutionSafety(substitutions, errors);

  for (const token of REQUIRED_IDENTITY_TOKENS[archetype]) {
    if (!Object.prototype.hasOwnProperty.call(substitutions, token)) {
      errors.push(`required_substitution_missing:${token}`);
    }
  }

  const clientSlug = substitutions.CLIENT_SLUG;
  if (clientSlug !== undefined) validateSlugValue('client_slug', clientSlug, errors);

  const locationIds = [];
  if (archetype === 'surf_house') {
    if (substitutions.LOCATION_ID !== undefined) {
      validateSlugValue('location_id', substitutions.LOCATION_ID, errors);
      locationIds.push(substitutions.LOCATION_ID);
    }
  } else {
    for (const key of ['LOCATION_ID_1', 'LOCATION_ID_2']) {
      if (substitutions[key] !== undefined) {
        validateSlugValue(key.toLowerCase(), substitutions[key], errors);
        locationIds.push(substitutions[key]);
      }
    }
  }

  if (locationIds.length !== new Set(locationIds).size) {
    errors.push('location_id_collision');
  }

  let existing;
  try {
    existing = loadExistingTenants(repoRoot);
  } catch (err) {
    return { ok: false, errors: [`existing_tenants_unreadable:${err.message}`] };
  }

  if (clientSlug && existing.clientSlugs.has(clientSlug)) {
    errors.push(`existing_tenant_conflict:${clientSlug}`);
  }
  for (const loc of locationIds) {
    if (existing.locationIds.has(loc)) {
      errors.push(`existing_location_conflict:${loc}`);
    }
  }

  // Collect required template tokens and ensure they are all provided.
  let templates;
  try {
    templates = loadArchetypeTemplates(repoRoot, archetype);
  } catch (err) {
    return { ok: false, errors: [`template_load_failed:${err.message}`] };
  }

  const needed = new Set(REQUIRED_IDENTITY_TOKENS[archetype]);
  for (const token of collectPlaceholders(templates.baseline)) needed.add(token);
  for (const token of collectPlaceholders(templates.secretsExample)) needed.add(token);
  if (templates.pricing) {
    for (const token of collectPlaceholders(templates.pricing)) needed.add(token);
  }
  for (const token of [...needed].sort()) {
    if (!Object.prototype.hasOwnProperty.call(substitutions, token)) {
      errors.push(`required_substitution_missing:${token}`);
    }
  }

  if (errors.length) return { ok: false, errors: [...new Set(errors)].sort() };

  const unresolved = new Set();
  const baseline = substituteTree(thaw(templates.baseline), substitutions, unresolved, null);
  const secretsExample = substituteTree(thaw(templates.secretsExample), substitutions, unresolved, null);
  const pricing = templates.pricing
    ? substituteTree(thaw(templates.pricing), substitutions, unresolved, null)
    : null;
  const registryEntry = buildRegistryEntry(archetype, substitutions);

  // Force disabled-by-default regardless of template drift.
  baseline.live_enabled = false;
  if (baseline.deployment && typeof baseline.deployment === 'object') {
    baseline.deployment.enabled = false;
  }
  if (baseline.channels && baseline.channels.whatsapp) {
    baseline.channels.whatsapp.enabled = false;
  }
  if (baseline.channels && baseline.channels.email) {
    baseline.channels.email.enabled = false;
  }
  if (baseline.payment && typeof baseline.payment === 'object') {
    baseline.payment.payment_link_auto_allowed = false;
  }
  if (getPath(baseline, 'service_addons.lesson_scheduling')) {
    baseline.service_addons.lesson_scheduling.enabled = false;
  }
  if (baseline._meta && typeof baseline._meta === 'object') {
    baseline._meta.status = 'dry_run_preview';
    baseline._meta.slice = SLICE;
  }
  registryEntry.live_enabled = false;

  assertEnablementFalse(baseline, archetype, errors);
  if (registryEntry.live_enabled !== false) {
    errors.push('registry_live_enabled_not_false');
  }

  for (const token of unresolved) {
    errors.push(`unresolved_placeholder:${token}`);
  }

  const relPaths = previewRelativePaths(archetype, clientSlug);
  const fileSpecs = [
    { kind: 'baseline', relativePath: relPaths.baseline, value: baseline },
    { kind: 'secrets_example', relativePath: relPaths.secrets_example, value: secretsExample },
    { kind: 'registry_entry', relativePath: relPaths.registry_entry, value: registryEntry },
  ];
  if (pricing) {
    fileSpecs.splice(1, 0, { kind: 'pricing', relativePath: relPaths.pricing, value: pricing });
  }

  const pathSet = new Set();
  for (const spec of fileSpecs) {
    if (pathSet.has(spec.relativePath)) errors.push(`output_path_collision:${spec.relativePath}`);
    pathSet.add(spec.relativePath);
    if (spec.relativePath.includes('..') || path.isAbsolute(spec.relativePath)) {
      errors.push(`output_path_traversal:${spec.relativePath}`);
    }
  }

  const files = [];
  for (const spec of fileSpecs) {
    const content = sortedStringify(spec.value);
    const forbidden = scanForbiddenContent(content);
    for (const id of forbidden) {
      errors.push(`output_forbidden:${spec.kind}:${id}`);
    }
    // Remaining placeholders in non-doc fields.
    const leftover = collectPlaceholders(spec.value);
    for (const token of leftover) {
      errors.push(`unresolved_placeholder:${token}`);
    }
    files.push({
      kind: spec.kind,
      relativePath: spec.relativePath,
      content,
      sha256: sha256Hex(content),
    });
  }

  if (errors.length) {
    return { ok: false, errors: [...new Set(errors)].sort() };
  }

  const manifest = {
    schema_version: 1,
    slice: SLICE,
    outcome_id: OUTCOME_ID,
    mode: MODE_DRY_RUN,
    archetype,
    client_slug: clientSlug,
    location_ids: locationIds,
    apply: false,
    writes_config_clients: false,
    writes_registry: false,
    runtime_loading: false,
    network: false,
    db: false,
    cloud: false,
    secrets_materialized: false,
    enablement_forced_false: true,
    template_hashes: templates.templateHashes,
    files: files.map((f) => ({
      kind: f.kind,
      relative_path: f.relativePath,
      sha256: f.sha256,
      bytes: Buffer.byteLength(f.content, 'utf8'),
    })).sort((a, b) => a.relative_path.localeCompare(b.relative_path)),
    substitutions_tokens: Object.keys(substitutions).sort(),
  };

  const manifestContent = sortedStringify(manifest);
  const manifestFile = {
    kind: 'manifest',
    relativePath: relPaths.manifest,
    content: manifestContent,
    sha256: sha256Hex(manifestContent),
  };

  return {
    ok: true,
    errors: [],
    files: [...files, manifestFile].sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    manifest,
  };
}

function resolveRepoRealpath(repoRoot) {
  const abs = path.resolve(repoRoot);
  return fs.realpathSync(abs);
}

function pathIsInsideOrEqual(candidate, root) {
  const c = path.resolve(candidate);
  const r = path.resolve(root);
  return c === r || c.startsWith(`${r}${path.sep}`);
}

function forbiddenRootReals(repoReal) {
  const out = [];
  for (const root of FORBIDDEN_OUTPUT_ROOTS) {
    const candidate = path.resolve(repoReal, root);
    let real = candidate;
    try {
      real = fs.realpathSync(candidate);
    } catch (_) {
      // Nonexistent forbidden roots still block by lexical resolve under repoReal.
    }
    out.push({ root, real, lexical: candidate });
  }
  return out;
}

function assertOutsideForbidden(absPath, repoReal, label) {
  for (const row of forbiddenRootReals(repoReal)) {
    if (pathIsInsideOrEqual(absPath, row.real) || pathIsInsideOrEqual(absPath, row.lexical)) {
      return `${label}_forbidden_root:${row.root}`;
    }
  }
  return null;
}

/**
 * lstat-check every existing ancestor of `startAbs` (inclusive) up to filesystem root.
 * Never follows symlinks; never descends into caller-controlled children.
 */
function assertNonSymlinkAncestorChain(startAbs) {
  let cur = path.resolve(startAbs);
  const seen = new Set();
  while (true) {
    if (seen.has(cur)) return { ok: false, error: 'output_dir_ancestor_cycle' };
    seen.add(cur);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { ok: false, error: `output_dir_ancestor_missing:${cur}` };
      }
      return { ok: false, error: `output_dir_ancestor_lstat_failed:${err && err.code}` };
    }
    if (st.isSymbolicLink()) {
      return { ok: false, error: `output_dir_ancestor_symlink:${cur}` };
    }
    if (!st.isDirectory()) {
      return { ok: false, error: `output_dir_ancestor_not_directory:${cur}` };
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { ok: true };
}

/**
 * Materialization target: final output directory must not exist. Its immediate
 * parent must exist; the existing parent/ancestor chain is lstat-checked
 * non-symlink and realpath-validated outside forbidden roots. Does not traverse
 * any caller-controlled descendants of the final path.
 */
function validateOutputMaterializationTarget(repoRoot, outputDir) {
  if (!outputDir || typeof outputDir !== 'string') {
    return { ok: false, error: 'output_dir_required' };
  }
  if (outputDir.includes('\0')) {
    return { ok: false, error: 'output_dir_nul' };
  }

  let repoReal;
  try {
    repoReal = resolveRepoRealpath(repoRoot);
  } catch (err) {
    return { ok: false, error: `repo_root_realpath_failed:${err && err.code}` };
  }

  const finalAbs = path.resolve(outputDir);
  const parentAbs = path.dirname(finalAbs);

  // Final must be nonexistent (lstat; do not follow; do not traverse descendants).
  try {
    const st = fs.lstatSync(finalAbs);
    if (st.isSymbolicLink()) {
      return { ok: false, error: 'output_dir_symlink' };
    }
    return { ok: false, error: 'output_dir_must_not_exist' };
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      return { ok: false, error: `output_dir_lstat_failed:${err && err.code}` };
    }
  }

  // Immediate parent must exist (sibling staging lives here).
  let parentStat;
  try {
    parentStat = fs.lstatSync(parentAbs);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: false, error: 'output_dir_parent_missing' };
    }
    return { ok: false, error: `output_dir_parent_lstat_failed:${err && err.code}` };
  }
  if (parentStat.isSymbolicLink()) {
    return { ok: false, error: 'output_dir_parent_symlink' };
  }
  if (!parentStat.isDirectory()) {
    return { ok: false, error: 'output_dir_parent_not_directory' };
  }

  const chain = assertNonSymlinkAncestorChain(parentAbs);
  if (!chain.ok) return chain;

  let parentReal;
  try {
    parentReal = fs.realpathSync(parentAbs);
  } catch (err) {
    return { ok: false, error: `output_dir_parent_realpath_failed:${err && err.code}` };
  }

  // Re-check realpath parent is still a non-symlink directory (no swap to symlink).
  try {
    const st = fs.lstatSync(parentReal);
    if (st.isSymbolicLink()) {
      return { ok: false, error: 'output_dir_parent_realpath_symlink' };
    }
    if (!st.isDirectory()) {
      return { ok: false, error: 'output_dir_parent_realpath_not_directory' };
    }
  } catch (err) {
    return { ok: false, error: `output_dir_parent_realpath_lstat_failed:${err && err.code}` };
  }

  const projectedFinal = path.join(parentReal, path.basename(finalAbs));
  const parentForbidden = assertOutsideForbidden(parentReal, repoReal, 'output_dir_parent');
  if (parentForbidden) return { ok: false, error: parentForbidden };
  const finalForbidden = assertOutsideForbidden(projectedFinal, repoReal, 'output_dir');
  if (finalForbidden) return { ok: false, error: finalForbidden };
  if (projectedFinal === repoReal) {
    return { ok: false, error: 'output_dir_cannot_be_repo_root' };
  }

  return {
    ok: true,
    finalAbs,
    parentAbs,
    parentReal,
    parentDev: parentStat.dev,
    parentIno: parentStat.ino,
    projectedFinal,
    finalName: path.basename(finalAbs),
    repoReal,
  };
}

/** @deprecated Prefer validateOutputMaterializationTarget; retained for callers. */
function isSafeOutputDirectory(repoRoot, outputDir) {
  const v = validateOutputMaterializationTarget(repoRoot, outputDir);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, resolved: v.projectedFinal };
}

function sameDevIno(aDev, aIno, bDev, bIno) {
  return Number(aDev) === Number(bDev) && String(aIno) === String(bIno);
}

function closeFdQuiet(fd) {
  if (fd == null || fd < 0) return;
  try {
    fs.closeSync(fd);
  } catch (_) {
    // ignore
  }
}

function cleanupStagingDir(stagingPath) {
  if (!stagingPath) return;
  try {
    fs.rmSync(stagingPath, { recursive: true, force: true });
  } catch (_) {
    // Best-effort; callers still fail closed on the original error.
  }
}

function pathExistsLstat(absPath) {
  try {
    fs.lstatSync(absPath);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Linux/GNU only: require exact `/usr/bin/mv` with `--no-copy`, `--no-clobber`,
 * and `-T` / `--no-target-directory`. Fail closed otherwise. Probe is not the
 * publish spawn (stdio must be readable here to inspect help/version).
 */
function assertGnuMvNoReplacePublishAvailable() {
  if (process.platform !== 'linux') {
    return { ok: false, error: 'gnu_mv_publish_unsupported_platform' };
  }
  let st;
  try {
    st = fs.lstatSync(GNU_MV_PATH);
  } catch (err) {
    return { ok: false, error: `gnu_mv_executable_unavailable:${err && err.code}` };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { ok: false, error: 'gnu_mv_executable_not_regular_file' };
  }
  try {
    fs.accessSync(GNU_MV_PATH, fs.constants.X_OK);
  } catch (err) {
    return { ok: false, error: `gnu_mv_executable_not_executable:${err && err.code}` };
  }

  const version = spawnSync(GNU_MV_PATH, ['--version'], {
    shell: false,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (version.error) {
    return { ok: false, error: `gnu_mv_version_probe_failed:${version.error.code || 'spawn'}` };
  }
  const versionText = `${version.stdout || ''}\n${version.stderr || ''}`;
  if (!/GNU\s+coreutils/i.test(versionText)) {
    return { ok: false, error: 'gnu_mv_not_gnu_coreutils' };
  }

  const help = spawnSync(GNU_MV_PATH, ['--help'], {
    shell: false,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (help.error) {
    return { ok: false, error: `gnu_mv_help_probe_failed:${help.error.code || 'spawn'}` };
  }
  const helpText = `${help.stdout || ''}\n${help.stderr || ''}`;
  if (!helpText.includes('--no-copy')) {
    return { ok: false, error: 'gnu_mv_required_options_unavailable:--no-copy' };
  }
  if (!helpText.includes('--no-clobber')) {
    return { ok: false, error: 'gnu_mv_required_options_unavailable:--no-clobber' };
  }
  if (!helpText.includes('--no-target-directory') && !/\s-T[,\s]/.test(helpText)) {
    return { ok: false, error: 'gnu_mv_required_options_unavailable:-T' };
  }
  return { ok: true };
}

/**
 * Sole local subprocess for disk-mode publish: argument-array spawn of
 * `/usr/bin/mv --no-copy --no-clobber -T` with closed/discarded stdio and no
 * shell. Publish argv paths must be `/proc/<pid>/fd/<fd>/…` so the child can
 * resolve the parent's open directory ( `/proc/self/fd` is process-local).
 */
function isProcFdAnchoredPath(absPath) {
  return typeof absPath === 'string'
    && (/^\/proc\/self\/fd\/\d+\//.test(absPath)
      || /^\/proc\/\d+\/fd\/\d+\//.test(absPath));
}

function spawnGnuMvNoReplacePublish(stagingPath, finalPath, options) {
  const avail = assertGnuMvNoReplacePublishAvailable();
  if (!avail.ok) return { ok: false, error: avail.error };

  if (!isProcFdAnchoredPath(stagingPath)) {
    return { ok: false, error: 'gnu_mv_publish_staging_not_fd_anchored' };
  }
  if (!isProcFdAnchoredPath(finalPath)) {
    return { ok: false, error: 'gnu_mv_publish_final_not_fd_anchored' };
  }

  const args = [...GNU_MV_PUBLISH_ARGS, stagingPath, finalPath];
  const spawnOpts = Object.freeze({
    shell: false,
    stdio: Object.freeze(['ignore', 'ignore', 'ignore']),
    windowsHide: true,
  });
  if (spawnOpts.shell !== false) {
    return { ok: false, error: 'gnu_mv_publish_shell_refused' };
  }

  if (options && typeof options.observePublishSpawn === 'function') {
    options.observePublishSpawn({
      file: GNU_MV_PATH,
      args: [...args],
      spawnOpts: {
        shell: spawnOpts.shell,
        stdio: [...spawnOpts.stdio],
        windowsHide: spawnOpts.windowsHide,
      },
    });
  }

  let result;
  if (options && typeof options.spawnPublish === 'function') {
    result = options.spawnPublish({
      file: GNU_MV_PATH,
      args: [...args],
      spawnOpts: {
        shell: spawnOpts.shell,
        stdio: [...spawnOpts.stdio],
        windowsHide: spawnOpts.windowsHide,
      },
    });
  } else {
    result = spawnSync(GNU_MV_PATH, args, {
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
  }

  if (!result || typeof result !== 'object') {
    return { ok: false, error: 'gnu_mv_publish_spawn_invalid_result' };
  }
  if (result.error) {
    return {
      ok: false,
      error: `gnu_mv_publish_spawn_error:${result.error.code || result.error.message || 'spawn'}`,
      result,
    };
  }
  if (result.signal) {
    return {
      ok: false,
      error: `gnu_mv_publish_signal:${result.signal}`,
      result,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: `gnu_mv_publish_nonzero:${result.status}`,
      result,
    };
  }
  return { ok: true, result };
}

/**
 * After any mv spawn outcome: classify fd-anchored staging/final vs the
 * captured staged directory inode. Never deletes — caller applies ownership
 * flags and cleanup.
 *
 * - owned_final: source gone + final is the staged directory inode
 * - source_present: our staging still present; any final is external (preserve)
 * - impossible: mismatched/unrecoverable; do not delete unowned paths
 */
function assessPublishOwnershipState(stagingPath, finalPath, stagedIdentity) {
  let sourcePresent = false;
  let sourceStat = null;
  try {
    sourceStat = fs.lstatSync(stagingPath);
    sourcePresent = true;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      return {
        ok: false,
        classification: 'impossible',
        error: `gnu_mv_publish_source_lstat_failed:${err && err.code}`,
        ownFinal: false,
        ownStaging: false,
      };
    }
  }

  let finalPresent = false;
  let finalStat = null;
  try {
    finalStat = fs.lstatSync(finalPath);
    finalPresent = true;
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      return {
        ok: false,
        classification: 'impossible',
        error: `gnu_mv_publish_final_lstat_failed:${err && err.code}`,
        ownFinal: false,
        ownStaging: false,
      };
    }
  }

  if (sourcePresent) {
    if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
      return {
        ok: false,
        classification: 'impossible',
        error: 'gnu_mv_publish_staging_not_directory',
        ownFinal: false,
        ownStaging: false,
      };
    }
    if (!sameDevIno(sourceStat.dev, sourceStat.ino, stagedIdentity.dev, stagedIdentity.ino)) {
      return {
        ok: false,
        classification: 'impossible',
        error: 'gnu_mv_publish_staging_inode_mismatch',
        ownFinal: false,
        ownStaging: false,
      };
    }
    // Our staging remains; final (if any) is not ours — preserve it.
    return {
      ok: true,
      classification: 'source_present',
      error: 'gnu_mv_publish_source_remaining',
      ownFinal: false,
      ownStaging: true,
      externalFinal: finalPresent,
    };
  }

  // Source gone.
  if (!finalPresent) {
    return {
      ok: false,
      classification: 'impossible',
      error: 'gnu_mv_publish_source_and_final_missing',
      ownFinal: false,
      ownStaging: false,
    };
  }
  if (finalStat.isSymbolicLink()) {
    return {
      ok: false,
      classification: 'impossible',
      error: 'gnu_mv_publish_final_is_symlink',
      ownFinal: false,
      ownStaging: false,
    };
  }
  if (!finalStat.isDirectory()) {
    return {
      ok: false,
      classification: 'impossible',
      error: 'gnu_mv_publish_final_not_directory',
      ownFinal: false,
      ownStaging: false,
    };
  }
  if (!sameDevIno(finalStat.dev, finalStat.ino, stagedIdentity.dev, stagedIdentity.ino)) {
    // Source gone but final is someone else's — do not claim ownership.
    return {
      ok: false,
      classification: 'impossible',
      error: 'gnu_mv_publish_inode_mismatch',
      ownFinal: false,
      ownStaging: false,
    };
  }
  return {
    ok: true,
    classification: 'owned_final',
    ownFinal: true,
    ownStaging: false,
    finalDev: finalStat.dev,
    finalIno: finalStat.ino,
  };
}

/**
 * List relative file paths under an fd-anchored directory without path.resolve
 * (resolve would collapse /proc/self/fd/<fd>/.. and break the anchor).
 */
function listRelativeFilesUnderAnchoredDir(dirPath) {
  const out = [];
  const walk = (rel) => {
    const abs = rel ? `${dirPath}/${rel}` : dirPath;
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const childAbs = `${dirPath}/${childRel}`;
      const st = fs.lstatSync(childAbs);
      if (st.isSymbolicLink()) {
        out.push({ relativePath: childRel, kind: 'symlink' });
        continue;
      }
      if (st.isDirectory()) {
        walk(childRel);
        continue;
      }
      if (st.isFile()) {
        out.push({ relativePath: childRel, kind: 'file' });
        continue;
      }
      out.push({ relativePath: childRel, kind: 'other' });
    }
  };
  walk('');
  return out;
}

/**
 * Re-read the fd-anchored exact output set and verify every byte/hash against
 * the precomputed preview/manifest. Rejects extras, missing paths, symlinks,
 * and hash/byte mismatches.
 */
function verifyAnchoredExactOutputBytes(finalPath, stagedFiles) {
  const expected = new Map();
  for (const file of stagedFiles) {
    if (!file || typeof file.relativePath !== 'string') {
      return { ok: false, error: 'gnu_mv_publish_content_path_invalid' };
    }
    const rel = file.relativePath.split(/[\\/]/).join('/');
    expected.set(rel, file);
  }

  let listed;
  try {
    listed = listRelativeFilesUnderAnchoredDir(finalPath);
  } catch (err) {
    return { ok: false, error: `gnu_mv_publish_final_readdir_failed:${err && err.code}` };
  }

  const seen = new Set();
  for (const ent of listed) {
    if (ent.kind === 'symlink') {
      return { ok: false, error: `gnu_mv_publish_content_is_symlink:${ent.relativePath}` };
    }
    if (ent.kind !== 'file') {
      return { ok: false, error: `gnu_mv_publish_content_not_file:${ent.relativePath}` };
    }
    if (!expected.has(ent.relativePath)) {
      return { ok: false, error: `gnu_mv_publish_unexpected_path:${ent.relativePath}` };
    }
    seen.add(ent.relativePath);
  }

  for (const [rel, file] of expected) {
    if (!seen.has(rel)) {
      return { ok: false, error: `gnu_mv_publish_content_missing:${rel}:ENOENT` };
    }
    const abs = `${finalPath}/${rel}`;
    if (!abs.startsWith(`${finalPath}/`)) {
      return { ok: false, error: `gnu_mv_publish_content_path_escape:${rel}` };
    }
    let bytes;
    try {
      bytes = fs.readFileSync(abs);
    } catch (err) {
      return {
        ok: false,
        error: `gnu_mv_publish_content_missing:${rel}:${err && err.code}`,
      };
    }
    if (sha256Hex(bytes) !== file.sha256) {
      return { ok: false, error: `gnu_mv_publish_content_mismatch:${rel}` };
    }
    if (typeof file.content === 'string' || Buffer.isBuffer(file.content)) {
      const expectedBuf = Buffer.isBuffer(file.content)
        ? file.content
        : Buffer.from(file.content, 'utf8');
      if (!bytes.equals(expectedBuf)) {
        return { ok: false, error: `gnu_mv_publish_content_mismatch:${rel}` };
      }
    }
  }
  return { ok: true };
}

/**
 * Zero-exit publish success helper: owned final (source absent, same inode) plus
 * exact output-set byte/hash match. Any source remaining (including GNU
 * `--no-clobber` skip of a preexisting empty/nonempty final) is failure.
 */
function assessNoReplacePublishSuccess(stagingPath, finalPath, stagedIdentity, stagedFiles) {
  const ownership = assessPublishOwnershipState(stagingPath, finalPath, stagedIdentity);
  if (ownership.classification !== 'owned_final') {
    return {
      ok: false,
      error: ownership.error || 'gnu_mv_publish_ambiguous_state',
    };
  }
  const bytes = verifyAnchoredExactOutputBytes(finalPath, stagedFiles);
  if (!bytes.ok) return bytes;
  return { ok: true, finalDev: ownership.finalDev, finalIno: ownership.finalIno };
}

/**
 * Linux-only: require /proc/self/fd and O_DIRECTORY|O_NOFOLLOW. Fail closed otherwise.
 */
function assertParentFdAnchorAvailable() {
  if (process.platform !== 'linux') {
    return { ok: false, error: 'parent_fd_anchor_unsupported_platform' };
  }
  if (!fs.constants.O_DIRECTORY || !fs.constants.O_NOFOLLOW) {
    return { ok: false, error: 'parent_fd_anchor_flags_unavailable' };
  }
  try {
    fs.accessSync('/proc/self/fd', fs.constants.R_OK | fs.constants.X_OK);
  } catch (err) {
    return { ok: false, error: `parent_fd_procfs_unavailable:${err && err.code}` };
  }
  return { ok: true };
}

/**
 * Open parent with O_DIRECTORY|O_NOFOLLOW, verify fstat matches expected identity,
 * and prove /proc/self/fd/<fd> resolves to the same directory inode.
 */
function openAnchoredParentDirectory(parentAbs, expectedDev, expectedIno) {
  const avail = assertParentFdAnchorAvailable();
  if (!avail.ok) return avail;

  let fd;
  try {
    fd = fs.openSync(
      parentAbs,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
  } catch (err) {
    return { ok: false, error: `parent_fd_open_failed:${err && err.code}` };
  }

  let st;
  try {
    st = fs.fstatSync(fd);
  } catch (err) {
    closeFdQuiet(fd);
    return { ok: false, error: `parent_fd_fstat_failed:${err && err.code}` };
  }
  if (!st.isDirectory()) {
    closeFdQuiet(fd);
    return { ok: false, error: 'parent_fd_not_directory' };
  }
  if (!sameDevIno(st.dev, st.ino, expectedDev, expectedIno)) {
    closeFdQuiet(fd);
    return { ok: false, error: 'parent_fd_identity_mismatch' };
  }

  const anchorBase = `/proc/self/fd/${fd}`;
  try {
    const pst = fs.statSync(anchorBase);
    if (!pst.isDirectory()) {
      closeFdQuiet(fd);
      return { ok: false, error: 'parent_fd_procfs_not_directory' };
    }
    if (!sameDevIno(pst.dev, pst.ino, st.dev, st.ino)) {
      closeFdQuiet(fd);
      return { ok: false, error: 'parent_fd_procfs_identity_mismatch' };
    }
  } catch (err) {
    closeFdQuiet(fd);
    return { ok: false, error: `parent_fd_procfs_stat_failed:${err && err.code}` };
  }

  return { ok: true, fd, anchorBase, dev: st.dev, ino: st.ino };
}

/**
 * Require the caller's parent pathname still names the anchored directory (dev/ino).
 */
function parentPathnameMatchesIdentity(parentAbs, expectedDev, expectedIno) {
  let st;
  try {
    st = fs.lstatSync(parentAbs);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: false, error: 'parent_pathname_missing' };
    }
    return { ok: false, error: `parent_pathname_lstat_failed:${err && err.code}` };
  }
  if (st.isSymbolicLink()) {
    return { ok: false, error: 'parent_pathname_became_symlink' };
  }
  if (!st.isDirectory()) {
    return { ok: false, error: 'parent_pathname_not_directory' };
  }
  if (!sameDevIno(st.dev, st.ino, expectedDev, expectedIno)) {
    return { ok: false, error: 'parent_pathname_identity_mismatch' };
  }
  return { ok: true };
}

function exclusiveWriteFile(absPath, content) {
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL;
  // O_NOFOLLOW rejects a symlink race on the leaf when the platform supports it.
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const fd = fs.openSync(absPath, flags | noFollow, 0o600);
  try {
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Materialize dry-run preview via private sibling staging + atomic no-replace
 * publish, anchored to an open parent directory fd so cleanup never depends on
 * the caller pathname (parent-rename race). Final directory must not exist.
 * Never overwrites (Node rename is not used — it can replace an empty final).
 * Linux/GNU disk mode publishes with the sole local subprocess
 * `/usr/bin/mv --no-copy --no-clobber -T` (argument array, fd-anchored paths,
 * closed stdio). After every spawn outcome, inspect fd-anchored staging/final
 * vs staged inode and track ownership explicitly before cleanup/return. After
 * post-publish hooks and parent identity checks, re-verify the exact output
 * set byte-for-byte against the precomputed preview. Cleans owned staging/final
 * via fd anchor on every error; never deletes unowned paths. Fail closed if fd
 * anchoring / procfs / exact GNU mv options are unavailable.
 */
function writeDryRunPreview(result, options) {
  if (!result || !result.ok) {
    return { ok: false, errors: (result && result.errors) || ['result_not_ok'] };
  }
  const repoRoot = options && options.repoRoot;
  const outputDir = options && options.outputDir;
  const safety = validateOutputMaterializationTarget(repoRoot, outputDir);
  if (!safety.ok) return { ok: false, errors: [safety.error] };

  const opened = openAnchoredParentDirectory(
    safety.parentAbs,
    safety.parentDev,
    safety.parentIno,
  );
  if (!opened.ok) {
    return { ok: false, errors: [opened.error] };
  }

  let parentFd = opened.fd;
  const anchorBase = opened.anchorBase;
  // Child processes cannot resolve the parent's /proc/self/fd/<fd>; publish argv
  // must use /proc/<pid>/fd/<fd> while in-process Node ops keep /proc/self/fd.
  const publishAnchorBase = `/proc/${process.pid}/fd/${parentFd}`;
  const parentDev = opened.dev;
  const parentIno = opened.ino;
  const finalName = safety.finalName;
  const stagingName = `.factory-1c-staging-${crypto.randomBytes(12).toString('hex')}`;
  // Paths under /proc/self/fd/<fd> stay bound to the open directory inode.
  const stagingPath = `${anchorBase}/${stagingName}`;
  const finalAnchored = `${anchorBase}/${finalName}`;
  const stagingPublishPath = `${publishAnchorBase}/${stagingName}`;
  const finalPublishPath = `${publishAnchorBase}/${finalName}`;
  let stagingCreated = false;
  let finalOwned = false;
  let stagedIdentity = null;

  const closeParent = () => {
    closeFdQuiet(parentFd);
    parentFd = null;
  };

  const cleanupAnchored = () => {
    // Never clean via caller pathname — parent may have been renamed/replaced.
    if (finalOwned) {
      cleanupStagingDir(finalAnchored);
      finalOwned = false;
    }
    if (stagingCreated) {
      cleanupStagingDir(stagingPath);
      stagingCreated = false;
    }
  };

  const fail = (errors) => {
    cleanupAnchored();
    closeParent();
    return { ok: false, errors: Array.isArray(errors) ? errors : [errors] };
  };

  try {
    fs.mkdirSync(stagingPath, { recursive: false, mode: 0o700 });
    stagingCreated = true;
  } catch (err) {
    return fail([`staging_mkdir_failed:${err && err.code}`]);
  }

  // Staging itself must be a real directory we own (not a symlink swap).
  try {
    const st = fs.lstatSync(stagingPath);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return fail(['staging_not_real_directory']);
    }
    stagedIdentity = { dev: st.dev, ino: st.ino };
  } catch (err) {
    return fail([`staging_lstat_failed:${err && err.code}`]);
  }

  const written = [];
  for (const file of result.files) {
    if (!file || typeof file.relativePath !== 'string' || file.relativePath.length === 0) {
      return fail(['write_relative_path_invalid']);
    }
    if (
      file.relativePath.includes('\0')
      || path.isAbsolute(file.relativePath)
      || file.relativePath.split(/[\\/]/).some((p) => p === '..')
    ) {
      return fail([`write_path_traversal:${file.relativePath}`]);
    }

    // Join without path.resolve — resolve() would collapse /proc/self/fd/<fd>/..
    // and break the fd anchor.
    const abs = `${stagingPath}/${file.relativePath.split(/[\\/]/).join('/')}`;
    if (!abs.startsWith(`${stagingPath}/`)) {
      return fail([`write_path_escape:${file.relativePath}`]);
    }

    try {
      const dirPart = abs.slice(0, abs.lastIndexOf('/'));
      fs.mkdirSync(dirPart, { recursive: true, mode: 0o700 });
      exclusiveWriteFile(abs, file.content);
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        return fail([`overwrite_refused:${file.relativePath}`]);
      }
      return fail([`write_failed:${file.relativePath}:${err && err.code}`]);
    }

    written.push({
      relativePath: file.relativePath,
      absolutePath: path.join(safety.projectedFinal, file.relativePath),
      sha256: file.sha256,
    });
  }

  // Refresh staged directory identity after writes (same inode expected).
  try {
    const st = fs.lstatSync(stagingPath);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return fail(['staging_not_real_directory']);
    }
    if (!sameDevIno(st.dev, st.ino, stagedIdentity.dev, stagedIdentity.ino)) {
      return fail(['staging_identity_changed']);
    }
    stagedIdentity = { dev: st.dev, ino: st.ino };
  } catch (err) {
    return fail([`staging_lstat_failed:${err && err.code}`]);
  }

  // Test hook: allow injecting a race (final appears / parent rename) before checks.
  if (options && typeof options.beforeAtomicRename === 'function') {
    try {
      options.beforeAtomicRename({
        finalAbs: finalAnchored,
        stagingPath,
        parentReal: safety.parentReal,
        parentAbs: safety.parentAbs,
        parentPathname: safety.parentAbs,
        projectedFinalPathname: safety.projectedFinal,
        anchorBase,
      });
    } catch (err) {
      return fail([`before_atomic_rename_hook_failed:${err && err.message}`]);
    }
  }

  // Requested parent pathname must still resolve to the anchored directory.
  {
    const id = parentPathnameMatchesIdentity(safety.parentAbs, parentDev, parentIno);
    if (!id.ok) return fail([id.error]);
  }

  // Fail closed if final appeared (symlink or any node) before publish — via fd anchor.
  try {
    const st = fs.lstatSync(finalAnchored);
    if (st.isSymbolicLink()) {
      return fail(['output_dir_appeared_symlink']);
    }
    return fail(['output_dir_appeared']);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      return fail([`output_dir_pre_publish_lstat_failed:${err && err.code}`]);
    }
  }

  // Parent fd must still name the same directory inode.
  try {
    const st = fs.fstatSync(parentFd);
    if (!st.isDirectory()) {
      return fail(['output_dir_parent_fd_not_directory']);
    }
    if (!sameDevIno(st.dev, st.ino, parentDev, parentIno)) {
      return fail(['output_dir_parent_fd_identity_changed']);
    }
  } catch (err) {
    return fail([`output_dir_parent_fd_fstat_failed:${err && err.code}`]);
  }

  // Test hook: inject immediately before publish (e.g. empty/nonempty final race).
  if (options && typeof options.beforeRenameAttempt === 'function') {
    try {
      options.beforeRenameAttempt({
        finalAbs: finalAnchored,
        stagingPath,
        parentAbs: safety.parentAbs,
        parentPathname: safety.parentAbs,
        projectedFinalPathname: safety.projectedFinal,
        anchorBase,
      });
    } catch (err) {
      return fail([`before_rename_attempt_hook_failed:${err && err.message}`]);
    }
  }

  // Atomic no-replace publish: never use Node rename APIs (empty final would be replaced).
  // Child mv sees /proc/<pid>/fd/<fd>/… (not /proc/self/fd).
  const spawned = spawnGnuMvNoReplacePublish(stagingPublishPath, finalPublishPath, options);

  // After EVERY spawn outcome (ok/error/signal/nonzero): inspect ownership before return.
  const ownership = assessPublishOwnershipState(stagingPath, finalAnchored, stagedIdentity);
  if (ownership.ownFinal) {
    finalOwned = true;
    stagingCreated = false;
  } else if (ownership.ownStaging) {
    finalOwned = false;
    // stagingCreated stays true — cleanup removes staging only; external final preserved.
  } else {
    // Impossible/mismatched: do not delete unowned paths.
    finalOwned = false;
    stagingCreated = false;
  }

  if (!spawned.ok) {
    // Bad spawn: owned final is removed by fail(); source_present cleans staging only.
    const errors = [spawned.error];
    if (ownership.classification === 'impossible' && ownership.error) {
      errors.push(ownership.error);
    }
    return fail(errors);
  }

  // Spawn reported success — require owned final (source gone + same inode).
  if (ownership.classification !== 'owned_final') {
    return fail([ownership.error || 'gnu_mv_publish_ambiguous_state']);
  }

  // Test hook: post-publish swap / parent rename / content tamper before identity re-check.
  if (options && typeof options.afterAtomicRename === 'function') {
    try {
      options.afterAtomicRename({
        finalAbs: finalAnchored,
        stagingPath,
        parentAbs: safety.parentAbs,
        parentPathname: safety.parentAbs,
        projectedFinalPathname: safety.projectedFinal,
        anchorBase,
      });
    } catch (err) {
      return fail([`after_atomic_rename_hook_failed:${err && err.message}`]);
    }
  }

  // After publish: pathname must still be the same directory; else remove final via fd.
  {
    const id = parentPathnameMatchesIdentity(safety.parentAbs, parentDev, parentIno);
    if (!id.ok) return fail([id.error]);
  }

  // Post-publish: final must still be a real directory (not a symlink) — via fd anchor.
  try {
    const st = fs.lstatSync(finalAnchored);
    if (st.isSymbolicLink()) {
      return fail(['output_dir_final_is_symlink']);
    }
    if (!st.isDirectory()) {
      return fail(['output_dir_final_not_directory']);
    }
    if (!sameDevIno(st.dev, st.ino, stagedIdentity.dev, stagedIdentity.ino)) {
      // No longer our inode — drop ownership so cleanup does not delete the stranger.
      finalOwned = false;
      return fail(['gnu_mv_publish_inode_mismatch']);
    }
  } catch (err) {
    return fail([`output_dir_final_lstat_failed:${err && err.code}`]);
  }

  // Immediately re-read fd-anchored exact output set; every byte/hash must match
  // the precomputed preview/manifest before success. Tampering fails + removes owned final.
  {
    const bytesCheck = verifyAnchoredExactOutputBytes(finalAnchored, result.files);
    if (!bytesCheck.ok) {
      return fail([bytesCheck.error]);
    }
  }

  closeParent();
  return {
    ok: true,
    errors: [],
    written,
    outputDir: safety.projectedFinal,
    stagingCleaned: true,
    publishMethod: 'gnu_mv_no_replace',
  };
}

function emitStdout(result) {
  if (!result || !result.ok) {
    return { ok: false, errors: (result && result.errors) || ['result_not_ok'] };
  }
  const payload = {
    manifest: result.manifest,
    files: result.files.map((f) => ({
      relativePath: f.relativePath,
      sha256: f.sha256,
      content: f.content,
    })),
  };
  return { ok: true, errors: [], stdout: sortedStringify(payload) };
}

/**
 * 1C ledger may claim complete only when the independent 1C verifier passed.
 */
function validate1cLedgerClaim(stage1c, gates, slice1cVerifierPassed) {
  const errors = [];
  if (!stage1c || stage1c.id !== '1C') {
    errors.push('1c_stage_missing');
    return errors;
  }
  if (stage1c.status === 'complete') {
    if (!slice1cVerifierPassed) {
      errors.push('1c_complete_without_independent_validator');
    }
    if (stage1c.completion_evidence !== COMPLETION_EVIDENCE) {
      errors.push('1c_complete_evidence_mismatch');
    }
    if (stage1c.completion_requires !== COMPLETION_REQUIRES) {
      errors.push('1c_complete_requires_mismatch');
    }
    const byId = new Map((gates || []).map((g) => [g.id, g]));
    for (const gateId of [
      'G_DISABLED_BY_DEFAULT_GENERATION',
      'G_SECRET_REJECTION',
      'G_NO_LIVE_TARGET_COPYING',
    ]) {
      const g = byId.get(gateId);
      if (!g || g.current_stage_evidence !== COMPLETION_EVIDENCE) {
        errors.push(`1c_gate_evidence_mismatch:${gateId}`);
      }
    }
  }
  return errors;
}

function buildFixtureSubstitutions(archetype, clientSlug) {
  const tokens = new Set(REQUIRED_IDENTITY_TOKENS[archetype]);
  // Minimal safe deterministic map; callers should merge full token coverage.
  const base = {
    CLIENT_SLUG: clientSlug,
    CLIENT_NAME: `Fixture ${clientSlug}`,
    TIMEZONE: 'Europe/Madrid',
    CURRENCY: 'EUR',
    LANGUAGE_PRIMARY: 'en',
    LANGUAGE_SECONDARY: 'es',
    ASSISTANT_NAME: 'Luna',
    BRAND_NAME: `Brand ${clientSlug}`,
    PERSONA_ROLE: 'front_desk',
    VOICE_SUMMARY: 'warm_concise',
    EMOJI_LEVEL: 'low',
    HANDOFF_LABEL: 'Host',
    HANDOFF_SAFE_REPLY: 'A teammate will help shortly.',
    HANDOFF_WHATSAPP_PHONE_E164: '+10000000000',
    HANDOFF_EMAIL_ADDRESS: 'handoff@example.test',
    MASTER_ADMIN_NUMBER_E164: '+10000000001',
    STAFF_ADMIN_PASSWORD: 'fixture-not-a-real-secret',
    HOLD_EXPIRY_MINUTES: '60',
    DEPOSIT_DEFAULT_EUR: '50',
    PRICE_EUR_PLACEHOLDER: '10',
    PRICE_CENTS_PLACEHOLDER: '1000',
    BALANCE_METHOD_1: 'card',
    BALANCE_METHOD_2: 'cash',
    NO_SHOW_POLICY: 'handoff',
    REFUND_DEFAULT_REMEDY: 'manual_staff_refund',
  };
  if (archetype === 'surf_house') {
    Object.assign(base, {
      LOCATION_ID: `${clientSlug}-main`,
      LOCATION_NAME: `${clientSlug} main`,
      PACKAGE_CODE_1: 'surf_week',
      PACKAGE_CODE_2: 'surf_plus',
      PACKAGE_CODE_3: 'full_board',
      PACKAGE_NAME_1: 'Surf week',
      PACKAGE_NAME_2: 'Surf plus',
      PACKAGE_NAME_3: 'Full board',
      INCLUSION_1: 'bed',
      INCLUSION_2: 'breakfast',
      INCLUSION_3: 'lesson',
      SEASON_SHOULDER: 'shoulder',
      SEASON_HIGH: 'high',
      SEASON_PEAK: 'peak',
      MONTH_1: 'april',
      MONTH_2: 'may',
      MONTH_3: 'june',
      MONTH_4: 'july',
      CLOSED_MONTH_1: 'november',
      CLOSED_MONTH_2: 'december',
      DOUBLE_ROOM_MODIFIER_EUR: '15',
      SERVICE_WETSUIT: 'wetsuit_rental',
      SERVICE_BOARD: 'board_rental',
      SERVICE_LESSON: 'surf_lesson',
      BUNDLE_1: 'wetsuit_board_combo',
      SLOT_1_TRANSPORT: '09:00',
      SLOT_1_WINDOW: '09:30-11:00',
      SLOT_2_TRANSPORT: '11:30',
      SLOT_2_WINDOW: '12:00-13:30',
      ROOM_ID_1: 'room-a',
      ROOM_ID_2: 'room-b',
      ROOM_CAPACITY_1: '4',
      ROOM_CAPACITY_2: '2',
      ROOM_TYPE_1: 'shared',
      ROOM_TYPE_2: 'double',
      DEPOSIT_STANDARD_EUR: '100',
      DEPOSIT_SHORT_EUR: '50',
      DEPOSIT_STANDARD_CENTS: '10000',
      DEPOSIT_SHORT_CENTS: '5000',
      DEPOSIT_DEFAULT_CENTS: '5000',
      PROPERTY_ADDRESS: '1 Example Street',
      MAPS_LINK: 'https://example.test/maps/fixture',
      GATE_CODE: '0000',
      CHECK_IN_TIME: '16:00',
      CHECK_OUT_TIME: '11:00',
      CLEANING_SCOPE: 'standard',
      CLEANING_BUFFER_MINUTES: '60',
      NO_NEXT_GUEST_RULE: 'buffer_required',
      ADDON_WETSUIT_NAME: 'Wetsuit',
      ADDON_SOFT_TOP_NAME: 'Soft top',
      ADDON_HARD_BOARD_NAME: 'Hard board',
      ADDON_WETSUIT_SOFT_COMBO_NAME: 'Wetsuit + soft top',
      ADDON_WETSUIT_HARD_COMBO_NAME: 'Wetsuit + hard board',
      ADDON_LESSON_SINGLE_NAME: 'Single lesson',
      ADDON_LESSON_MULTI_NAME: 'Multi lesson',
      ADDON_YOGA_NAME: 'Yoga',
      ADDON_MEAL_NAME: 'Meal',
      ADDON_MEALS_NAME: 'Meals',
      ROOM_SUPPLEMENT_SHARED_CENTS: '0',
      ROOM_SUPPLEMENT_DOUBLE_CENTS: '1500',
      ROOM_SUPPLEMENT_PRIVATE_CENTS: '2500',
      ROOM_SUPPLEMENT_DOUBLE_PERSON_CENTS: '1500',
      ROOM_SUPPLEMENT_PRIVATE_PERSON_CENTS: '2500',
      PRORATION_FORMULA_PLACEHOLDER: 'round_up_5',
    });
  } else {
    Object.assign(base, {
      LOCATION_ID_1: `${clientSlug}-a`,
      LOCATION_ID_2: `${clientSlug}-b`,
      LOCATION_NAME_1: `${clientSlug} A`,
      LOCATION_NAME_2: `${clientSlug} B`,
      RENTAL_WINDOW_1: '2h',
      RENTAL_WINDOW_2: 'half_day',
      RENTAL_WINDOW_3: 'full_day',
      RENTAL_BOARD: 'board',
      RENTAL_BOARD_LABEL: 'Board',
      RENTAL_WETSUIT: 'wetsuit',
      RENTAL_WETSUIT_LABEL: 'Wetsuit',
      RENTAL_BUNDLE: 'bundle',
      RENTAL_BUNDLE_LABEL: 'Bundle',
      LESSON_SLOT_1: '09:00',
      LESSON_SLOT_2: '11:00',
      ARRIVE_BEFORE_MINUTES: '15',
      LESSON_GROUP_ADULT: 'group_adult',
      LESSON_GROUP_ADULT_LABEL: 'Group adult',
      LESSON_KIDS: 'kids',
      LESSON_KIDS_LABEL: 'Kids',
      LESSON_PRIVATE: 'private',
      LESSON_PRIVATE_LABEL: 'Private',
      ACCOMMODATION_PACKAGE: 'stay_pack',
      ACCOMMODATION_PACKAGE_LABEL: 'Stay pack',
      ACCOMMODATION_INCLUDE_1: 'breakfast',
      ACCOMMODATION_INCLUDE_2: 'transfer',
      DEPOSIT_RULE_TYPE: 'fixed',
      DEPOSIT_RULE_SCOPE: 'per_booking',
      REFUND_POLICY: 'manual',
      BAD_WEATHER_POLICY: 'reschedule_or_credit',
    });
  }
  for (const t of tokens) {
    if (!Object.prototype.hasOwnProperty.call(base, t)) {
      base[t] = `fixture_${t.toLowerCase()}`;
    }
  }
  return base;
}

deepFreeze(ARCHETYPE_IDS);
deepFreeze(ALLOWED_MODES);
deepFreeze(REQUIRED_IDENTITY_TOKENS);
deepFreeze(GENERATED_FILE_KINDS);
deepFreeze(TEMPLATE_SOURCE_FILES);
deepFreeze(FORBIDDEN_OUTPUT_ROOTS);
deepFreeze(ALLOWED_TIP_PATH_PREFIXES);
deepFreeze(EXISTING_REGRESSION_GATES);
deepFreeze(DOC_FIELD_KEYS);

module.exports = Object.freeze({
  SLICE,
  BRANCH,
  MASTER_BASIS,
  OUTCOME_ID,
  COMPLETION_EVIDENCE,
  COMPLETION_REQUIRES,
  ARCHETYPE_IDS,
  MODE_DRY_RUN,
  ALLOWED_MODES,
  SLUG_RE,
  PLACEHOLDER_RE,
  REQUIRED_IDENTITY_TOKENS,
  GENERATED_FILE_KINDS,
  TEMPLATE_SOURCE_FILES,
  FORBIDDEN_OUTPUT_ROOTS,
  ALLOWED_TIP_PATH_PREFIXES,
  PACKAGE_JSON_ALLOWED_SCRIPT_KEY,
  PACKAGE_JSON_ALLOWED_SCRIPT_VALUE,
  EXISTING_REGRESSION_GATES,
  FORBIDDEN_CONTENT_PATTERNS,
  GNU_MV_PATH,
  GNU_MV_PUBLISH_ARGS,
  thaw,
  deepEqual,
  sha256Hex,
  sortedStringify,
  sortKeysDeep,
  scanForbiddenContent,
  collectPlaceholders,
  isStrictSlug,
  isSafeOutputDirectory,
  validateOutputMaterializationTarget,
  expectedOutputPathSet,
  previewRelativePaths,
  loadArchetypeTemplates,
  loadExistingTenants,
  generateDryRunPreview,
  writeDryRunPreview,
  emitStdout,
  validate1cLedgerClaim,
  buildFixtureSubstitutions,
  cleanupStagingDir,
  assertGnuMvNoReplacePublishAvailable,
  spawnGnuMvNoReplacePublish,
  assessPublishOwnershipState,
  verifyAnchoredExactOutputBytes,
  assessNoReplacePublishSuccess,
});
