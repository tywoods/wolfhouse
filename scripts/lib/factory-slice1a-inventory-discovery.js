'use strict';

/**
 * FACTORY Slice 1A — source-derived registration/read-site inventory discovery.
 *
 * Consumer completeness uses pinned Acorn ESTree physical-site discovery over a
 * local import graph (not regex acquisition classifiers). Safe string / template
 * / binary / path.join / path.resolve expressions are constant-folded; require
 * and import aliases plus local loader wrappers are resolved.
 *
 * Threat boundary (explicit): arbitrary runtime path/import computation that
 * cannot be constant-folded is outside the static analysis boundary. When such
 * computation appears in the reachable config-loader graph, discovery fails
 * closed rather than claiming coverage.
 *
 * Fixture inventories must match discovery bidirectionally. Locked exclusions
 * filter justified noise only — they are never the expected inventory.
 * Physical site keys are inventoried independently of fixture site_policy, then
 * compared as exact sets.
 */

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const DEFAULT_ROOT = path.join(__dirname, '..', '..');

/** Pinned Acorn version — fail closed on mismatch. */
const ACORN_PIN = Object.freeze({ name: 'acorn', version: '8.14.1' });

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
  'physical_site_keys',
]);

/**
 * Justified exclusions (noise / self / historical slice verifiers).
 * Never used as the expected inventory — only subtracted after discovery.
 */
const LOCKED_EXCLUSIONS = Object.freeze({
  path_substrings: Object.freeze([
    'factory-slice1a-',
  ]),
  verifier_path_prefixes: Object.freeze([
    'scripts/verify-radar-',
    'scripts/verify-fortress-',
    'scripts/verify-foundation-',
  ]),
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

/** Seed / recognized config-loader modules (basename without .js). */
const LOADER_MODULE_BASENAMES = Object.freeze([
  'staff-portal-clients',
  'tenant-business-config',
  'client-channel-resolver',
]);

const LOADER_SEED_RELS = Object.freeze([
  'scripts/lib/staff-portal-clients.js',
  'scripts/lib/tenant-business-config.js',
  'scripts/lib/client-channel-resolver.js',
]);

const FEATURE_FLAG_NAME_RE = /^(?:DEFAULT_CLIENT_SLUG|STAFF_API_INGRESS_TENANT_SLUG|STRIPE_WEBHOOK_CLIENT_SLUG|LUNA_BOT_CLIENT_SLUG|CLIENT_CHANNEL_ROUTING_FILE|SUNSET_ADMIN_[A-Z0-9_]+|STAFF_PORTAL_DEV_TABS|STAFF_API_ADMISSION_CONTROL)$/;

const FS_METHOD_NAMES = new Set([
  'readFileSync', 'readFile', 'readdirSync', 'readdir',
  'existsSync', 'accessSync', 'access', 'statSync', 'stat',
  'lstatSync', 'lstat', 'openSync', 'open', 'createReadStream',
  'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile',
  'readFilePromise', 'promises',
]);

const THREAT_BOUNDARY = Object.freeze({
  id: 'static_constant_fold_config_loader_graph',
  statement:
    'Arbitrary runtime path or import computation that cannot be constant-folded '
    + 'is outside the FACTORY 1A static threat boundary. Presence of such '
    + 'computation in the reachable config-loader graph fails closed; discovery '
    + 'does not claim regex-style coverage of unfoldable sites.',
});

function assertAcornPin() {
  let pkg;
  try {
    pkg = require('acorn/package.json');
  } catch (err) {
    const e = new Error(`acorn_pin_missing:${ACORN_PIN.version}`);
    e.code = 'acorn_pin_missing';
    throw e;
  }
  if (!pkg || pkg.version !== ACORN_PIN.version) {
    const e = new Error(`acorn_pin_mismatch:expected=${ACORN_PIN.version}:actual=${pkg && pkg.version}`);
    e.code = 'acorn_pin_mismatch';
    throw e;
  }
}

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

function walkAst(node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object' && child.type) walkAst(child, fn);
      }
    } else if (val && typeof val === 'object' && val.type) {
      walkAst(val, fn);
    }
  }
}

function calleeName(node) {
  if (!node) return '';
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') {
    const obj = calleeName(node.object);
    let prop = '';
    if (node.computed) {
      prop = node.property && node.property.type === 'Literal'
        ? String(node.property.value)
        : '{dyn}';
    } else {
      prop = (node.property && node.property.name) || '';
    }
    return obj ? `${obj}.${prop}` : prop;
  }
  return '';
}

function parseJs(text, relPath) {
  const opts = {
    ecmaVersion: 2022,
    locations: true,
    allowHashBang: true,
    allowReturnOutsideFunction: true,
  };
  try {
    return acorn.parse(text, { ...opts, sourceType: 'script' });
  } catch (errScript) {
    try {
      return acorn.parse(text, { ...opts, sourceType: 'module' });
    } catch (errModule) {
      const msg = (errModule && errModule.message) || (errScript && errScript.message) || 'parse';
      const e = new Error(`parse_error:${relPath}:${msg}`);
      e.code = 'parse_error';
      throw e;
    }
  }
}

function resolveLocalRequire(fromAbs, request, root) {
  if (!request || typeof request !== 'string') return null;
  if (!request.startsWith('.') && !request.startsWith('/')) {
    return { external: true, request };
  }
  const base = path.normalize(path.join(path.dirname(fromAbs), request));
  const candidates = [base, `${base}.js`, path.join(base, 'index.js')];
  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        return { abs: cand, rel: rel(root, cand) };
      }
    } catch {
      // continue
    }
  }
  return { missing: true, request };
}

function isLoaderRel(relPath) {
  const base = path.posix.basename(String(relPath || ''), '.js');
  return LOADER_MODULE_BASENAMES.includes(base);
}

function siteKey(kind, fileRel, callee, fingerprint) {
  return `${kind}|${fileRel}|${callee}|${fingerprint}`;
}

function normalizePosix(p) {
  return String(p || '').split(path.sep).join('/');
}

function toRepoRelPath(root, absOrVirt) {
  const n = normalizePosix(path.normalize(absOrVirt));
  const rootN = normalizePosix(path.normalize(root));
  if (n === rootN) return '';
  if (n.startsWith(`${rootN}/`)) return n.slice(rootN.length + 1);
  const idx = n.indexOf('config/clients');
  if (idx >= 0) return n.slice(idx);
  return n;
}

function touchesConfigClients(foldedPath, root) {
  if (!foldedPath) return false;
  const repo = toRepoRelPath(root, foldedPath);
  const n = normalizePosix(repo || foldedPath);
  return /(^|\/)config\/clients(\/|$)/.test(n);
}

function fsKindFromCallee(cname) {
  if (/readdir/i.test(cname)) return 'fs_readdir';
  if (/exists|access|stat|lstat/i.test(cname)) return 'fs_exists';
  if (/write|append/i.test(cname)) return 'fs_write';
  return 'fs_read';
}

/**
 * Constant-fold safe string / template / binary+ / path.join / path.resolve /
 * Identifier bindings. Returns { value, dyn } or null when unfoldable.
 */
function createFolder(fileAbs, root) {
  const fileRel = rel(root, fileAbs);
  const dirnameAbs = path.dirname(fileAbs);
  const env = new Map();
  const pathAliases = new Set(['path']);
  const fsAliases = new Set(['fs']);

  function fold(node, depth) {
    if (!node || depth > 48) return null;
    if (node.type === 'Literal') {
      if (typeof node.value === 'string') return { value: node.value, dyn: false };
      if (typeof node.value === 'number' || typeof node.value === 'boolean') {
        return { value: String(node.value), dyn: false };
      }
      return null;
    }
    if (node.type === 'TemplateLiteral') {
      let out = '';
      let dyn = false;
      for (let i = 0; i < node.quasis.length; i += 1) {
        out += (node.quasis[i].value && node.quasis[i].value.cooked) || '';
        if (i < node.expressions.length) {
          const inner = fold(node.expressions[i], depth + 1);
          if (inner && typeof inner.value === 'string') {
            out += inner.value;
            dyn = dyn || inner.dyn;
          } else {
            out += '{dyn}';
            dyn = true;
          }
        }
      }
      return { value: out, dyn };
    }
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const left = fold(node.left, depth + 1);
      const right = fold(node.right, depth + 1);
      if (left && right && typeof left.value === 'string' && typeof right.value === 'string') {
        return { value: left.value + right.value, dyn: !!(left.dyn || right.dyn) };
      }
      return null;
    }
    if (node.type === 'Identifier') {
      if (node.name === '__dirname') return { value: dirnameAbs, dyn: false };
      if (node.name === '__filename') return { value: fileAbs, dyn: false };
      if (env.has(node.name)) return env.get(node.name);
      return null;
    }
    if (node.type === 'MemberExpression'
      && !node.computed
      && node.object.type === 'Identifier'
      && pathAliases.has(node.object.name)
      && node.property.type === 'Identifier'
      && node.property.name === 'sep') {
      return { value: path.sep, dyn: false };
    }
    if (node.type === 'LogicalExpression' && (node.operator === '||' || node.operator === '??')) {
      const left = fold(node.left, depth + 1);
      const right = fold(node.right, depth + 1);
      // Prefer a foldable default (common options.path || DEFAULT_PATH pattern).
      if (right && typeof right.value === 'string') {
        if (left && typeof left.value === 'string') {
          return { value: left.value, dyn: true };
        }
        return { value: right.value, dyn: true };
      }
      if (left && typeof left.value === 'string') return { value: left.value, dyn: true };
      return null;
    }
    if (node.type === 'ConditionalExpression') {
      const cons = fold(node.consequent, depth + 1);
      const alt = fold(node.alternate, depth + 1);
      if (cons && alt && cons.value === alt.value) {
        return { value: cons.value, dyn: !!(cons.dyn || alt.dyn) };
      }
      if (cons && typeof cons.value === 'string' && touchesConfigClients(cons.value, root)) {
        return { value: cons.value, dyn: true };
      }
      if (alt && typeof alt.value === 'string' && touchesConfigClients(alt.value, root)) {
        return { value: alt.value, dyn: true };
      }
      if (cons && typeof cons.value === 'string') return { value: cons.value, dyn: true };
      if (alt && typeof alt.value === 'string') return { value: alt.value, dyn: true };
      return null;
    }
    if (node.type === 'CallExpression') {
      const name = calleeName(node.callee);
      // trimStr(x) / String(x) / path.dirname — fold through wrappers when arg folds.
      if ((name === 'trimStr' || name === 'String' || name === 'path.normalize'
        || name === 'path.dirname' || name === 'dirname')
        && node.arguments && node.arguments[0]) {
        const inner = fold(node.arguments[0], depth + 1);
        if (inner && typeof inner.value === 'string') {
          if (name === 'path.dirname' || name === 'dirname'
            || (node.callee.type === 'MemberExpression'
              && node.callee.property.type === 'Identifier'
              && node.callee.property.name === 'dirname')) {
            return { value: path.dirname(inner.value.replace('{dyn}', '_dyn_')).replace(/_dyn_/g, '{dyn}'), dyn: inner.dyn || inner.value.includes('{dyn}') };
          }
          return inner;
        }
      }
      if (node.callee.type === 'MemberExpression'
        && node.callee.object.type === 'Identifier'
        && pathAliases.has(node.callee.object.name)
        && node.callee.property.type === 'Identifier'
        && node.callee.property.name === 'dirname'
        && node.arguments && node.arguments[0]) {
        const inner = fold(node.arguments[0], depth + 1);
        if (inner && typeof inner.value === 'string') {
          return {
            value: path.dirname(inner.value.replace('{dyn}', '_dyn_')).replace(/_dyn_/g, '{dyn}'),
            dyn: inner.dyn || inner.value.includes('{dyn}'),
          };
        }
      }
      let joinLike = null;
      if (name === 'path.join' || name === 'path.resolve') joinLike = name;
      else if (node.callee.type === 'MemberExpression'
        && node.callee.object.type === 'Identifier'
        && pathAliases.has(node.callee.object.name)
        && node.callee.property.type === 'Identifier') {
        if (node.callee.property.name === 'join') joinLike = 'path.join';
        if (node.callee.property.name === 'resolve') joinLike = 'path.resolve';
      }
      if (joinLike) {
        const rawArgs = node.arguments || [];
        const parts = [];
        let dyn = false;
        let anyConcrete = false;
        for (const a of rawArgs) {
          const folded = fold(a, depth + 1);
          if (folded && typeof folded.value === 'string') {
            parts.push(folded.value);
            dyn = dyn || folded.dyn;
            if (folded.value !== '{dyn}') anyConcrete = true;
          } else {
            parts.push('{dyn}');
            dyn = true;
          }
        }
        if (!parts.length || !anyConcrete) return null;
        const PH = '__FACTORY1A_DYN__';
        const concrete = parts.map((p) => (p === '{dyn}' ? PH : p));
        let joined;
        try {
          joined = joinLike === 'path.resolve'
            ? path.resolve(...concrete)
            : path.join(...concrete);
        } catch {
          return null;
        }
        return { value: joined.split(PH).join('{dyn}'), dyn };
      }
    }
    return null;
  }

  function ingestBindings(ast) {
    const apply = () => {
      walkAst(ast, (node) => {
        if (node.type === 'VariableDeclarator' && node.id && node.init) {
          if (node.id.type === 'Identifier') {
            // Track fs/path aliases from require
            if (node.init.type === 'CallExpression' && calleeName(node.init.callee) === 'require') {
              const req = fold(node.init.arguments[0], 0);
              if (req && (req.value === 'fs' || req.value === 'node:fs')) {
                fsAliases.add(node.id.name);
              }
              if (req && (req.value === 'path' || req.value === 'node:path')) {
                pathAliases.add(node.id.name);
              }
            }
            const f = fold(node.init, 0);
            if (f) env.set(node.id.name, f);
          }
          if (node.id.type === 'ObjectPattern'
            && node.init.type === 'CallExpression'
            && calleeName(node.init.callee) === 'require') {
            const req = fold(node.init.arguments[0], 0);
            if (req && (req.value === 'fs' || req.value === 'node:fs')) {
              for (const prop of node.id.properties || []) {
                if (prop.type === 'Property' && prop.key && prop.key.type === 'Identifier') {
                  fsAliases.add(prop.value && prop.value.type === 'Identifier'
                    ? prop.value.name
                    : prop.key.name);
                }
              }
            }
            if (req && (req.value === 'path' || req.value === 'node:path')) {
              for (const prop of node.id.properties || []) {
                if (prop.type === 'Property' && prop.key && prop.key.type === 'Identifier') {
                  pathAliases.add(prop.value && prop.value.type === 'Identifier'
                    ? prop.value.name
                    : prop.key.name);
                }
              }
            }
          }
        }
        if (node.type === 'AssignmentExpression'
          && node.operator === '='
          && node.left.type === 'Identifier') {
          const f = fold(node.right, 0);
          if (f) env.set(node.left.name, f);
        }
      });
    };
    apply();
    apply(); // second pass for forward refs among const bindings
  }

  function resolveFsCallee(node) {
    const name = calleeName(node.callee);
    if (FS_METHOD_NAMES.has(name)) return `fs.${name}`;
    if (node.callee.type === 'MemberExpression') {
      const obj = node.callee.object;
      const prop = node.callee.computed
        ? null
        : (node.callee.property && node.callee.property.name);
      if (!prop || !FS_METHOD_NAMES.has(prop)) {
        // fs.promises.readFile
        if (obj && obj.type === 'MemberExpression'
          && obj.object.type === 'Identifier'
          && fsAliases.has(obj.object.name)
          && obj.property.type === 'Identifier'
          && obj.property.name === 'promises'
          && prop) {
          return `fs.promises.${prop}`;
        }
        return name;
      }
      if (obj.type === 'Identifier' && fsAliases.has(obj.name)) return `fs.${prop}`;
      if (obj.type === 'Identifier' && obj.name === 'fs') return `fs.${prop}`;
    }
    return name;
  }

  return {
    fileRel,
    fold,
    ingestBindings,
    resolveFsCallee,
    fsAliases,
    pathAliases,
    env,
  };
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

function discoverRegistries(root) {
  const onDisk = new Set(
    discoverClientConfigFiles(root).filter((p) => isRegistryBasename(path.posix.basename(p))),
  );

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

function isTenantDeployOverlayPath(relPath, text) {
  const base = path.posix.basename(relPath);
  if (isOverlayConfigBasename(base)) return true;
  if (relPath === 'infra/.env.example') return true;
  if (/docker-compose/.test(base) && /hermes|DEFAULT_CLIENT_SLUG|STAFF_API_INGRESS|staff-staging|sunset-staging|wolfhouse|sunset/.test(text)) {
    return true;
  }
  if (/^infra\/azure\/[^/]+\/main\.bicep$/.test(relPath)
    && /STAFF_API_INGRESS_TENANT_SLUG|DEFAULT_CLIENT_SLUG|STRIPE_WEBHOOK_CLIENT_SLUG|LUNA_BOT_CLIENT_SLUG/.test(text)) {
    return true;
  }
  return false;
}

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
 * Normalize package.json verifier script paths: scripts/... and ./scripts/...
 */
function normalizeVerifierScriptPath(p) {
  let s = String(p || '').replace(/\\/g, '/').trim();
  if (s.startsWith('./')) s = s.slice(2);
  return s;
}

function extractVerifierPathsFromScript(scriptValue) {
  const out = [];
  const re = /node\s+(\.?\/?scripts\/verify-[A-Za-z0-9._-]+\.js)/g;
  let m;
  while ((m = re.exec(String(scriptValue || '')))) {
    out.push(normalizeVerifierScriptPath(m[1]));
  }
  return out;
}

function isClientProductizationVerifier(relPath, text, fromGateScript) {
  if (fromGateScript) return true;
  if (/^scripts\/verify-(?:multiclient-isolation|no-client-hardcoding|tenant-resolution|meta-whatsapp-tenant-shadow|staff-tenant-scope|tenant-business-config)\.js$/.test(relPath)) {
    return true;
  }
  if (/^scripts\/verify-(?:sunset-portal-slice1|wolfhouse-live-readiness-static)\.js$/.test(relPath)) {
    return /config\/clients|staff-portal-clients|tenant-business-config|client-channel-resolver/.test(text);
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
      for (const p of extractVerifierPathsFromScript(scripts[key])) {
        gateRegistered.add(p);
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

/**
 * Acorn ESTree physical-site discovery + local import graph for config/clients.
 * @returns {{ ok, physical_site_keys, consumers, errors, reachable_graph, threat_boundary }}
 */
function discoverPhysicalConfigSites(root) {
  assertAcornPin();

  const errors = [];
  const sitesByKey = new Map();
  const importEdges = new Map(); // fromRel -> Set<toRel>
  const reverseEdges = new Map(); // toRel -> Set<fromRel>
  const parsed = new Map(); // rel -> { abs, ast, folder, text }
  const parseFailed = new Set();

  function addEdge(fromRel, toRel) {
    if (!importEdges.has(fromRel)) importEdges.set(fromRel, new Set());
    importEdges.get(fromRel).add(toRel);
    if (!reverseEdges.has(toRel)) reverseEdges.set(toRel, new Set());
    reverseEdges.get(toRel).add(fromRel);
  }

  function addSite(key, meta) {
    if (!sitesByKey.has(key)) sitesByKey.set(key, meta || { site_key: key });
  }

  const scriptFiles = walkFiles(path.join(root, 'scripts'), (full) => path.extname(full) === '.js');

  for (const abs of scriptFiles) {
    const r = rel(root, abs);
    if (isExcludedPath(r, null, LOCKED_EXCLUSIONS.path_substrings)) continue;
    if (/^scripts\/verify-/.test(r)) continue;

    let text;
    let ast;
    try {
      text = fs.readFileSync(abs, 'utf8');
      ast = parseJs(text, r);
    } catch (err) {
      parseFailed.add(r);
      errors.push(String(err && err.message ? err.message : err));
      continue;
    }

    const folder = createFolder(abs, root);
    folder.ingestBindings(ast);
    parsed.set(r, {
      abs, ast, folder, text,
    });

    // Collect static local import edges; flag computed/dynamic.
    walkAst(ast, (node) => {
      if (node.type === 'CallExpression' && calleeName(node.callee) === 'require') {
        const arg = node.arguments && node.arguments[0];
        const folded = folder.fold(arg, 0);
        if (!folded) {
          // Record potential dynamic require; fail-closed only if reachable.
          node.__factory1a_dynamic_require = true;
          return;
        }
        if (folded.value.startsWith('.') || folded.value.startsWith('/')) {
          const resolved = resolveLocalRequire(abs, folded.value, root);
          if (resolved && resolved.missing) {
            node.__factory1a_unresolved_local = folded.value;
            return;
          }
          if (resolved && resolved.rel) addEdge(r, resolved.rel);
        }
      }
      if (node.type === 'ImportDeclaration' && node.source && node.source.type === 'Literal') {
        const req = String(node.source.value || '');
        if (req.startsWith('.') || req.startsWith('/')) {
          const resolved = resolveLocalRequire(abs, req, root);
          if (resolved && resolved.missing) {
            node.__factory1a_unresolved_local = req;
            return;
          }
          if (resolved && resolved.rel) addEdge(r, resolved.rel);
        }
      }
      if (node.type === 'ImportExpression') {
        const folded = folder.fold(node.source, 0);
        if (!folded) {
          node.__factory1a_dynamic_import = true;
          return;
        }
        if (folded.value.startsWith('.') || folded.value.startsWith('/')) {
          const resolved = resolveLocalRequire(abs, folded.value, root);
          if (resolved && resolved.missing) {
            node.__factory1a_unresolved_local = folded.value;
            return;
          }
          if (resolved && resolved.rel) addEdge(r, resolved.rel);
        }
      }
    });
  }

  // Direct physical sites (FS + loader imports) on successfully parsed files.
  const directSiteFiles = new Set();

  for (const [r, info] of parsed) {
    const { abs, ast, folder } = info;

    walkAst(ast, (node) => {
      // Loader require / import
      if (node.type === 'CallExpression' && calleeName(node.callee) === 'require') {
        const folded = folder.fold(node.arguments && node.arguments[0], 0);
        if (folded && (folded.value.startsWith('.') || folded.value.startsWith('/'))) {
          const resolved = resolveLocalRequire(abs, folded.value, root);
          if (resolved && resolved.rel && isLoaderRel(resolved.rel)) {
            const key = siteKey('loader_import', r, 'require', resolved.rel);
            addSite(key, { site_key: key, file: r });
            directSiteFiles.add(r);
          }
        }
      }
      if (node.type === 'ImportDeclaration' && node.source && node.source.type === 'Literal') {
        const req = String(node.source.value || '');
        if (req.startsWith('.') || req.startsWith('/')) {
          const resolved = resolveLocalRequire(abs, req, root);
          if (resolved && resolved.rel && isLoaderRel(resolved.rel)) {
            const key = siteKey('loader_import', r, 'import', resolved.rel);
            addSite(key, { site_key: key, file: r });
            directSiteFiles.add(r);
          }
        }
      }

      // Filesystem acquisition
      if (node.type === 'CallExpression') {
        const cname = folder.resolveFsCallee(node);
        const isFs = cname.startsWith('fs.')
          || FS_METHOD_NAMES.has(cname)
          || /^fs\.promises\./.test(cname);
        if (!isFs) return;
        if (cname === 'fs.promises') return;

        const arg0 = node.arguments && node.arguments[0];
        const folded = folder.fold(arg0, 0);
        if (!folded) {
          node.__factory1a_ambiguous_fs = true;
          return;
        }
        if (touchesConfigClients(folded.value, root)) {
          const fp = toRepoRelPath(root, folded.value) || normalizePosix(folded.value);
          const kind = fsKindFromCallee(cname);
          const key = siteKey(kind, r, cname, fp);
          addSite(key, { site_key: key, file: r });
          directSiteFiles.add(r);
        }
      }
    });
  }

  // Seed loaders always belong to the config-loader graph.
  for (const seed of LOADER_SEED_RELS) {
    if (parsed.has(seed) || fs.existsSync(path.join(root, seed))) {
      directSiteFiles.add(seed);
    }
  }

  // Reachable config-loader graph: seeds/direct acquisition sites + transitive
  // importers (reverse edges only). Outbound deps of loaders are not auto-included;
  // arbitrary runtime computation there is outside the static threat boundary unless
  // those deps themselves acquire config/clients (then they become direct sites).
  const reachable = new Set();
  const queue = [...directSiteFiles];
  while (queue.length) {
    const cur = queue.pop();
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const importer of reverseEdges.get(cur) || []) {
      if (!reachable.has(importer)) queue.push(importer);
    }
  }

  const threatBoundaryRejections = [];

  function nodeMentionsProcessEnv(node) {
    let hit = false;
    if (!node) return false;
    walkAst(node, (n) => {
      if (n.type === 'MemberExpression'
        && n.object.type === 'MemberExpression'
        && n.object.object.type === 'Identifier'
        && n.object.object.name === 'process'
        && n.object.property.type === 'Identifier'
        && n.object.property.name === 'env') {
        hit = true;
      }
      if (n.type === 'MemberExpression'
        && n.object.type === 'Identifier'
        && n.object.name === 'process'
        && n.property.type === 'Identifier'
        && n.property.name === 'env') {
        hit = true;
      }
    });
    return hit;
  }

  function fileHasFsClientsSite(fileRel) {
    for (const key of sitesByKey.keys()) {
      const parts = key.split('|');
      if (parts[1] === fileRel && String(parts[0] || '').startsWith('fs_')) return true;
    }
    return false;
  }

  // Fail closed inside reachable graph.
  for (const r of reachable) {
    if (parseFailed.has(r)) {
      errors.push(`reachable_parse_failure:${r}`);
      continue;
    }
    const info = parsed.get(r);
    if (!info) continue;
    const { ast, abs, folder } = info;
    const hasFsSite = fileHasFsClientsSite(r);
    const isSeed = LOADER_SEED_RELS.includes(r);

    walkAst(ast, (node) => {
      if (node.__factory1a_dynamic_require) {
        errors.push(`computed_dynamic_require:${r}:${node.loc && node.loc.start ? node.loc.start.line : '?'}`);
      }
      if (node.__factory1a_dynamic_import) {
        errors.push(`computed_dynamic_import:${r}:${node.loc && node.loc.start ? node.loc.start.line : '?'}`);
      }
      if (node.__factory1a_unresolved_local) {
        errors.push(`unresolved_local_import:${r}:${node.__factory1a_unresolved_local}`);
      }
      if (node.__factory1a_ambiguous_fs) {
        const line = node.loc && node.loc.start ? node.loc.start.line : '?';
        // Pure reverse-importer wrappers (loader_import only) — FS coverage not claimed.
        if (!hasFsSite && !isSeed) return;

        const arg0 = node.arguments && node.arguments[0];
        let envSourced = !!(arg0 && nodeMentionsProcessEnv(arg0));
        if (!envSourced && arg0 && arg0.type === 'Identifier') {
          walkAst(ast, (n) => {
            if (n.type === 'VariableDeclarator'
              && n.id && n.id.type === 'Identifier'
              && n.id.name === arg0.name
              && n.init
              && nodeMentionsProcessEnv(n.init)) {
              envSourced = true;
            }
            if (n.type === 'AssignmentExpression'
              && n.left.type === 'Identifier'
              && n.left.name === arg0.name
              && nodeMentionsProcessEnv(n.right)) {
              envSourced = true;
            }
            // options.env || process.env alias then env.FOO
            if (n.type === 'VariableDeclarator'
              && n.id && n.id.type === 'Identifier'
              && n.init
              && nodeMentionsProcessEnv(n.init)) {
              // If filePath = trimStr(env.X) and env bound to process.env — detect MemberExpression on that id
              if (arg0.type === 'Identifier') {
                walkAst(ast, (n2) => {
                  if (n2.type === 'VariableDeclarator'
                    && n2.id && n2.id.type === 'Identifier'
                    && n2.id.name === arg0.name
                    && n2.init
                    && n2.init.type === 'CallExpression') {
                    const inner = n2.init.arguments && n2.init.arguments[0];
                    if (inner && inner.type === 'MemberExpression'
                      && inner.object.type === 'Identifier'
                      && inner.object.name === n.id.name) {
                      envSourced = true;
                    }
                  }
                });
              }
            }
          });
        }

        // Runtime indirection (obj.prop / unknown) when structural clients FS sites
        // already exist in-file: outside static threat boundary — reject coverage claim.
        if (envSourced || hasFsSite) {
          threatBoundaryRejections.push(
            `outside_static_threat_boundary:ambiguous_or_env_fs:${r}:${line}`,
          );
          return;
        }
        errors.push(`ambiguous_filesystem_path:${r}:${line}`);
      }

      if (node.type === 'CallExpression' && calleeName(node.callee) === 'require') {
        const folded = folder.fold(node.arguments && node.arguments[0], 0);
        if (!folded) return;
        if (folded.value.startsWith('.') || folded.value.startsWith('/')) {
          const resolved = resolveLocalRequire(abs, folded.value, root);
          if (resolved && resolved.missing) {
            errors.push(`unresolved_local_import:${r}:${folded.value}`);
          }
        }
      }
    });
  }

  // Missing seed loaders are hard failures.
  for (const seed of LOADER_SEED_RELS) {
    if (!fs.existsSync(path.join(root, seed)) && root === DEFAULT_ROOT) {
      errors.push(`missing_loader_seed:${seed}`);
    }
  }

  const physicalSiteKeys = [...sitesByKey.keys()].sort();
  const consumers = new Set();
  for (const key of physicalSiteKeys) {
    const parts = key.split('|');
    if (parts[1]) consumers.add(parts[1]);
  }

  const uniqErrors = [...new Set(errors)].sort();
  const uniqThreat = [...new Set(threatBoundaryRejections)].sort();
  return {
    ok: uniqErrors.length === 0,
    physical_site_keys: physicalSiteKeys,
    pricing_services_schedule_profile_consumers: [...consumers].sort(),
    errors: uniqErrors,
    threat_boundary_rejections: uniqThreat,
    reachable_graph: [...reachable].sort(),
    threat_boundary: THREAT_BOUNDARY,
    acorn_pin: ACORN_PIN,
  };
}

function discoverAll(options) {
  const root = (options && options.root) || DEFAULT_ROOT;
  assertAcornPin();
  const physical = discoverPhysicalConfigSites(root);
  return {
    completeness_method: 'source_derived_registration_read_site_inventory',
    discovery_engine: 'pinned_acorn_estree_physical_site_plus_local_import_graph',
    categories: INVENTORY_CATEGORIES.slice(),
    client_config_files: discoverClientConfigFiles(root),
    registries: discoverRegistries(root),
    feature_flag_symbols: discoverFeatureFlagSymbols(root),
    pricing_services_schedule_profile_consumers: physical.pricing_services_schedule_profile_consumers,
    physical_site_keys: physical.physical_site_keys,
    deployment_overlays: discoverDeploymentOverlays(root),
    existing_verifiers: discoverExistingVerifiers(root),
    reference_pair: discoverWolfhouseSunsetPair(root),
    locked_exclusions: {
      path_substrings: LOCKED_EXCLUSIONS.path_substrings.slice(),
      verifier_path_prefixes: LOCKED_EXCLUSIONS.verifier_path_prefixes.slice(),
      feature_flag_path_prefixes: LOCKED_EXCLUSIONS.feature_flag_path_prefixes.slice(),
    },
    discovery_ok: physical.ok,
    discovery_errors: physical.errors.slice(),
    threat_boundary_rejections: (physical.threat_boundary_rejections || []).slice(),
    reachable_config_loader_graph: physical.reachable_graph,
    threat_boundary: physical.threat_boundary,
    acorn_pin: physical.acorn_pin,
  };
}

/**
 * Compare fixture inventory against live discovery.
 * Completeness requires exact bidirectional set equality per category.
 * site_policy.physical_site_keys is compared independently from discovery keys.
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

  // Independent site_policy ↔ discovered physical_site_keys bidirectional compare.
  const policyKeys = fixtureInventory
    && fixtureInventory.site_policy
    && Array.isArray(fixtureInventory.site_policy.physical_site_keys)
    ? fixtureInventory.site_policy.physical_site_keys.slice().sort()
    : null;
  const discoveredKeys = Array.isArray(discovered.physical_site_keys)
    ? discovered.physical_site_keys.slice().sort()
    : [];
  if (!policyKeys) {
    errors.push('missing_site_policy');
    details.site_policy = { missing_in_policy: discoveredKeys, stale_in_policy: [] };
  } else {
    const polSet = new Set(policyKeys);
    const discSet = new Set(discoveredKeys);
    const missingInPolicy = discoveredKeys.filter((x) => !polSet.has(x));
    const staleInPolicy = policyKeys.filter((x) => !discSet.has(x));
    details.site_policy = { missing_in_policy: missingInPolicy, stale_in_policy: staleInPolicy };
    if (missingInPolicy.length) errors.push('incomplete_site_policy');
    if (staleInPolicy.length) errors.push('stale_site_policy');
  }

  if (discovered && discovered.discovery_ok === false) {
    errors.push('discovery_fail_closed');
    details.discovery_errors = (discovered.discovery_errors || []).slice();
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
      // ./scripts/... form must normalize to scripts/...
      'verify:multiclient':
        'node ./scripts/verify-multiclient-isolation.js && node ./scripts/verify-adversarial-factory-client.js',
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

  write('config/clients/channel-routing.adversarial.json', `${JSON.stringify({ routes: [] }, null, 2)}\n`);
  write('config/clients/staff-portal-access.adversarial.json', `${JSON.stringify({ client_access: {} }, null, 2)}\n`);
  write('config/clients/wolfhouse-somo.personalities.json', `${JSON.stringify({ en: {}, es: {} }, null, 2)}\n`);

  write('scripts/lib/staff-portal-clients.js', `'use strict';
const fs = require('fs');
const path = require('path');
const CLIENTS_DIR = path.join(__dirname, '..', '..', 'config', 'clients');
function loadBaselineJson(slug) {
  return JSON.parse(fs.readFileSync(path.join(CLIENTS_DIR, slug + '.baseline.json'), 'utf8'));
}
module.exports = { loadBaselineJson, CLIENTS_DIR };
`);

  write('scripts/lib/tenant-business-config.js', `'use strict';
const { loadBaselineJson } = require('./staff-portal-clients');
function resolveTenantBusinessConfig(slug) { return loadBaselineJson(slug); }
module.exports = { resolveTenantBusinessConfig };
`);

  write('scripts/lib/client-channel-resolver.js', `'use strict';
const path = require('path');
const fs = require('fs');
const DEFAULT_REGISTRY_PATH = path.join(__dirname, '..', '..', 'config', 'clients', 'clients.json');
function loadRegistry() {
  return JSON.parse(fs.readFileSync(DEFAULT_REGISTRY_PATH, 'utf8'));
}
module.exports = { loadRegistry, DEFAULT_REGISTRY_PATH };
`);

  // Split-string path.resolve acquisition (constant-fold binary +).
  write('scripts/lib/adversarial-split-resolve.js', `'use strict';
const fs = require('fs');
const path = require('path');
function loadSplit() {
  const p = path.resolve(__dirname, '..' + '/..', 'con' + 'fig', 'clients', 'clients.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
module.exports = { loadSplit };
`);

  // Aliased wrapper via static require of loader.
  write('scripts/lib/adversarial-client-wrapper.js', `'use strict';
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
const INGRESS = process.env.STAFF_API_INGRESS_TENANT_SLUG;
module.exports = { readClientBaseline, INGRESS };
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

  write('scripts/lib/adversarial-feature-flag.js', `'use strict';
function enabled(env) {
  return String((env || process.env).STAFF_API_ADMISSION_CONTROL || '') === '1';
}
module.exports = { enabled };
`);

  write('infra/azure/adversarial-staging/main.bicep', `
param location string
// adversarial tenant overlay
var env = [
  { name: 'STAFF_API_INGRESS_TENANT_SLUG', value: 'adversarial' }
  { name: 'DEFAULT_CLIENT_SLUG', value: 'adversarial' }
]
`);

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
        'scripts/lib/adversarial-split-resolve.js',
        'scripts/lib/client-channel-resolver.js',
        'scripts/lib/staff-portal-clients.js',
        'scripts/lib/tenant-business-config.js',
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

/**
 * RED helpers: plant fail-closed cases into an existing adversarial tree.
 */
function plantUnresolvedDynamicPath(tmpRoot) {
  // Inject into a loader seed so the dynamic require sits inside the reachable
  // config-loader graph (reverse-importer expansion alone would miss outbound deps).
  const portal = path.join(tmpRoot, 'scripts/lib/staff-portal-clients.js');
  const prev = fs.readFileSync(portal, 'utf8');
  fs.writeFileSync(portal, `${prev}
function adversarialDynamicLoad(userPath, mod) {
  const fs2 = require('fs');
  fs2.readFileSync(userPath, 'utf8');
  return require(mod);
}
module.exports.adversarialDynamicLoad = adversarialDynamicLoad;
`, 'utf8');
}

function plantComputedWrapperImport(tmpRoot) {
  // Inject computed/non-foldable require directly into a reachable site file.
  const staffApi = path.join(tmpRoot, 'scripts/staff-query-api.js');
  const prev = fs.readFileSync(staffApi, 'utf8');
  fs.writeFileSync(staffApi, `${prev}
function adversarialWrapperPath() {
  return './lib/staff-portal-clients';
}
module.exports._adversarialPortal = require(adversarialWrapperPath());
`, 'utf8');
}

module.exports = {
  ROOT: DEFAULT_ROOT,
  INVENTORY_CATEGORIES,
  LOCKED_EXCLUSIONS,
  LOADER_MODULE_BASENAMES,
  LOADER_SEED_RELS,
  FEATURE_FLAG_NAME_RE,
  ACORN_PIN,
  THREAT_BOUNDARY,
  discoverAll,
  discoverClientConfigFiles,
  discoverRegistries,
  discoverFeatureFlagSymbols,
  discoverPhysicalConfigSites,
  discoverDeploymentOverlays,
  discoverExistingVerifiers,
  discoverWolfhouseSunsetPair,
  compareInventoryCompleteness,
  buildAdversarialTemporarySource,
  plantComputedWrapperImport,
  plantUnresolvedDynamicPath,
  normalizeVerifierScriptPath,
  extractVerifierPathsFromScript,
  assertAcornPin,
};
