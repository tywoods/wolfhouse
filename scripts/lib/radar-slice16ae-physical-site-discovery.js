'use strict';

/**
 * RADAR 16AE — physical-site discovery over an explicit production import graph.
 *
 * Python sites: scripts/lib/radar-slice16ae-scan-python-sites.py (stdlib ast)
 * Node sites: Acorn AST over explicit JS graph nodes
 *
 * Discovery emits structural site keys only — never consumes adapter IDs.
 * Fail-closed on parse errors, unresolved dynamic imports/calls, and
 * production imports into exclusions.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const acorn = require('acorn');

const PYTHON_SCANNER_REL = 'scripts/lib/radar-slice16ae-scan-python-sites.py';

const JS_GRAPH_NODES = Object.freeze([
  'scripts/lib/staff-bot-v2-routes.js',
  'scripts/lib/luna-whatsapp-provider.js',
  'scripts/lib/luna-hermes-whatsapp-thread-mirror.js',
  'scripts/lib/luna-guest-handoff-persist.js',
  'scripts/lib/stripe-payment-reconcile.js',
  'scripts/lib/sunset-waiver-booking.js',
]);

const EXCLUSION_MARKERS = Object.freeze([
  '/fixtures/',
  '/node_modules/',
  '/docs/',
  '/__pycache__/',
  '/test_',
  '.test.',
  '_test.',
  '/simulate_',
]);

const PRIMITIVE_KINDS = Object.freeze([
  'meta_graph_http_client',
  'staff_http_client',
  'db_pool_client',
  'stripe_sdk',
  'in_process_queue',
  'hermes_session_store',
]);

function rootJoin(root, ...parts) {
  return path.join(root || path.join(__dirname, '..', '..'), ...parts);
}

function isExcluded(rel) {
  const norm = `/${String(rel).replace(/\\/g, '/')}`;
  const base = path.basename(rel);
  if (base.startsWith('test_') || base.includes('.test.') || base.endsWith('_test.js')) {
    return true;
  }
  if (base.startsWith('simulate_')) return true;
  return EXCLUSION_MARKERS.some((m) => norm.includes(m));
}

function siteKey(kind, rel, callee, fp) {
  return `${kind}|${rel}|${callee}|${fp}`;
}

function walkAst(node, fn, parent) {
  if (!node || typeof node !== 'object') return;
  fn(node, parent || null);
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === 'object' && child.type) walkAst(child, fn, node);
      }
    } else if (val && typeof val === 'object' && val.type) {
      walkAst(val, fn, node);
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

function staticStr(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') {
    let out = '';
    for (let i = 0; i < node.quasis.length; i += 1) {
      out += (node.quasis[i].value && node.quasis[i].value.cooked) || '';
      if (i < node.expressions.length) {
        const expr = node.expressions[i];
        if (expr && expr.type === 'Literal' && typeof expr.value === 'string') {
          out += expr.value;
        } else {
          out += '{dyn}';
        }
      }
    }
    return out;
  }
  return null;
}

function parseJs(text, rel) {
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
      const e = new Error(`parse_error:${rel}:${msg}`);
      e.code = 'parse_error';
      throw e;
    }
  }
}

function resolveRequire(fromAbs, request, root) {
  if (!request || (!request.startsWith('.') && !request.startsWith('/'))) {
    return null; // package / builtin — not part of production graph nodes
  }
  const base = path.normalize(path.join(path.dirname(fromAbs), request));
  const candidates = [
    base,
    `${base}.js`,
    path.join(base, 'index.js'),
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      const rel = path.relative(root, cand).replace(/\\/g, '/');
      return { abs: cand, rel };
    }
  }
  return { missing: true, request };
}

/**
 * Scan explicit JS production graph nodes with Acorn.
 * @param {string} root
 * @returns {object}
 */
function discoverJsPhysicalSites(root) {
  const parseErrors = [];
  const unresolvedDynamics = [];
  const prodIntoExcl = [];
  const sitesByKey = new Map();
  const scanned = [];

  function addSite(site) {
    const prev = sitesByKey.get(site.site_key);
    if (prev) {
      prev.evidence_sites.push({ lineno: site.lineno, col: site.col });
      return;
    }
    site.evidence_sites = [{ lineno: site.lineno, col: site.col }];
    sitesByKey.set(site.site_key, site);
  }

  for (const rel of JS_GRAPH_NODES) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      parseErrors.push(`missing_graph_node:${rel}`);
      continue;
    }
    if (isExcluded(rel)) {
      prodIntoExcl.push(`graph_node_is_exclusion:${rel}`);
      continue;
    }
    scanned.push(rel);
    let text;
    let ast;
    try {
      text = fs.readFileSync(abs, 'utf8');
      ast = parseJs(text, rel);
    } catch (err) {
      parseErrors.push(String(err.message || err));
      continue;
    }

    // Import-graph edges: static require only; fail on dynamic; fail if edge hits exclusion.
    walkAst(ast, (node) => {
      if (node.type === 'CallExpression' && calleeName(node.callee) === 'require') {
        const arg = node.arguments && node.arguments[0];
        const req = staticStr(arg);
        if (req == null) {
          unresolvedDynamics.push(
            `unresolved_dynamic_require:${rel}:${node.loc.start.line}`,
          );
          return;
        }
        const resolved = resolveRequire(abs, req, root);
        if (resolved && resolved.missing) {
          // Static relative require to a non-graph dependency — allowed.
          // Fail closed only on dynamic require (above) or exclusion hits.
          return;
        }
        if (resolved && resolved.rel && isExcluded(resolved.rel)) {
          prodIntoExcl.push(`${rel}->excluded:${resolved.rel}`);
        }
      }
      if (node.type === 'ImportExpression') {
        const src = staticStr(node.source);
        if (src == null) {
          unresolvedDynamics.push(
            `unresolved_dynamic_import:${rel}:${node.loc.start.line}`,
          );
        } else if (src.startsWith('.') || src.startsWith('/')) {
          const resolved = resolveRequire(abs, src, root);
          if (resolved && resolved.rel && isExcluded(resolved.rel)) {
            prodIntoExcl.push(`${rel}->excluded:${resolved.rel}`);
          }
        }
      }
    });

    // Physical sites
    walkAst(ast, (node) => {
      if (node.type === 'FunctionDeclaration' && node.id && node.id.name) {
        const fname = node.id.name;
        const line = node.loc.start.line;
        const col = node.loc.start.column;
        if (fname === 'sendLunaWhatsAppMessage') {
          addSite({
            site_key: siteKey('meta_graph_http_client', rel, fname, 'send'),
            primitive_kind: 'meta_graph_http_client',
            file: rel,
            lineno: line,
            col,
            callee: fname,
            fingerprint: 'send',
            evidence: `function ${fname}`,
          });
        }
        if (fname === 'mirrorHermesWhatsAppThreadMessage') {
          addSite({
            site_key: siteKey('db_pool_client', rel, fname, 'mirror_write'),
            primitive_kind: 'db_pool_client',
            file: rel,
            lineno: line,
            col,
            callee: fname,
            fingerprint: 'mirror_write',
            evidence: `function ${fname}`,
          });
        }
        if (fname === 'markConversationNeedsHumanByPhone') {
          addSite({
            site_key: siteKey('db_pool_client', rel, fname, 'handoff_persist'),
            primitive_kind: 'db_pool_client',
            file: rel,
            lineno: line,
            col,
            callee: fname,
            fingerprint: 'handoff_persist',
            evidence: `function ${fname}`,
          });
        }
        if (fname === 'reconcilePendingStripePaymentsForBooking') {
          addSite({
            site_key: siteKey('db_pool_client', rel, fname, 'reconcile_write'),
            primitive_kind: 'db_pool_client',
            file: rel,
            lineno: line,
            col,
            callee: fname,
            fingerprint: 'reconcile_write',
            evidence: `function ${fname}`,
          });
        }
        if (fname === 'ensureWaiverForBookingSoft') {
          addSite({
            site_key: siteKey('db_pool_client', rel, fname, 'waiver_ensure'),
            primitive_kind: 'db_pool_client',
            file: rel,
            lineno: line,
            col,
            callee: fname,
            fingerprint: 'waiver_ensure',
            evidence: `function ${fname}`,
          });
        }
      }

      if (node.type === 'CallExpression') {
        const name = calleeName(node.callee);
        if (
          name === 'stripe.checkout.sessions.create'
          || name.endsWith('.checkout.sessions.create')
          || name === 'checkout.sessions.create'
        ) {
          // Only count sites in explicit graph nodes (already scoped).
          addSite({
            site_key: siteKey('stripe_sdk', rel, 'checkout.sessions.create', 'create'),
            primitive_kind: 'stripe_sdk',
            file: rel,
            lineno: node.loc.start.line,
            col: node.loc.start.column,
            callee: 'checkout.sessions.create',
            fingerprint: 'create',
            evidence: name,
          });
        }
      }
    });
  }

  const sites = [...sitesByKey.values()];
  const counts = {};
  for (const site of sites) {
    counts[site.primitive_kind] = (counts[site.primitive_kind] || 0) + 1;
  }
  const ok = parseErrors.length === 0
    && unresolvedDynamics.length === 0
    && prodIntoExcl.length === 0;

  return Object.freeze({
    ok,
    language: 'javascript',
    graph_nodes: JS_GRAPH_NODES,
    scanned_files: Object.freeze(scanned),
    scanned_count: scanned.length,
    sites: Object.freeze(sites),
    site_count: sites.length,
    counts_by_primitive: Object.freeze(counts),
    parse_errors: Object.freeze(parseErrors),
    unresolved_dynamics: Object.freeze(unresolvedDynamics),
    production_imports_into_exclusions: Object.freeze(prodIntoExcl),
    fail_closed: !ok,
  });
}

/**
 * Run Python AST scanner subprocess.
 * @param {string} root
 * @returns {object}
 */
function discoverPythonPhysicalSites(root) {
  // Scanner script always lives in the real repo (next to this module), even when
  // `root` is a temp overlay used for source-mutation RED fixtures.
  const scanner = path.join(__dirname, 'radar-slice16ae-scan-python-sites.py');
  const result = spawnSync('python3', [scanner, root], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) {
    return Object.freeze({
      ok: false,
      language: 'python',
      fail_closed: true,
      parse_errors: [`python_scanner_spawn_failed:${result.error.message}`],
      unresolved_dynamics: Object.freeze([]),
      production_imports_into_exclusions: Object.freeze([]),
      sites: Object.freeze([]),
      site_count: 0,
      counts_by_primitive: Object.freeze({}),
    });
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (err) {
    return Object.freeze({
      ok: false,
      language: 'python',
      fail_closed: true,
      parse_errors: [
        `python_scanner_json_parse_failed:${err.message}:stderr=${String(result.stderr || '').slice(0, 400)}`,
      ],
      unresolved_dynamics: Object.freeze([]),
      production_imports_into_exclusions: Object.freeze([]),
      sites: Object.freeze([]),
      site_count: 0,
      counts_by_primitive: Object.freeze({}),
    });
  }
  return Object.freeze({
    ...report,
    ok: report.ok === true,
    fail_closed: report.ok !== true,
    sites: Object.freeze(report.sites || []),
    parse_errors: Object.freeze(report.parse_errors || []),
    unresolved_dynamics: Object.freeze(report.unresolved_dynamics || []),
    production_imports_into_exclusions: Object.freeze(
      report.production_imports_into_exclusions || [],
    ),
    counts_by_primitive: Object.freeze(report.counts_by_primitive || {}),
  });
}

/**
 * Discover all physical sites (Python + JS) over the explicit production graph.
 * @param {string} [rootDir]
 * @param {{ pythonReport?: object, jsReport?: object }} [options] — test overrides
 * @returns {object}
 */
function discoverPhysicalSites(rootDir, options) {
  const root = rootDir || rootJoin();
  const opts = options || {};
  const python = opts.pythonReport || discoverPythonPhysicalSites(root);
  const js = opts.jsReport || discoverJsPhysicalSites(root);

  const errors = [];
  for (const label of ['python', 'javascript']) {
    const rep = label === 'python' ? python : js;
    for (const e of rep.parse_errors || []) errors.push(`${label}:${e}`);
    for (const e of rep.unresolved_dynamics || []) errors.push(`${label}:${e}`);
    for (const e of rep.production_imports_into_exclusions || []) {
      errors.push(`${label}:${e}`);
    }
  }

  const sitesByKey = new Map();
  for (const site of [...(python.sites || []), ...(js.sites || [])]) {
    if (!sitesByKey.has(site.site_key)) sitesByKey.set(site.site_key, site);
  }
  const sites = [...sitesByKey.values()].sort((a, b) => a.site_key.localeCompare(b.site_key));
  const countsByPrimitive = {};
  for (const kind of PRIMITIVE_KINDS) countsByPrimitive[kind] = 0;
  for (const site of sites) {
    countsByPrimitive[site.primitive_kind] = (countsByPrimitive[site.primitive_kind] || 0) + 1;
  }

  const ok = errors.length === 0 && python.ok === true && js.ok === true;
  return Object.freeze({
    ok,
    fail_closed: !ok,
    errors: Object.freeze(errors),
    python,
    javascript: js,
    sites: Object.freeze(sites),
    site_keys: Object.freeze(sites.map((s) => s.site_key)),
    site_count: sites.length,
    scanner_counts: Object.freeze({
      python_sites: python.site_count || 0,
      javascript_sites: js.site_count || 0,
      total_sites: sites.length,
      by_primitive: Object.freeze({ ...countsByPrimitive }),
      python_scanned_files: python.scanned_count || 0,
      javascript_scanned_files: js.scanned_count || 0,
    }),
    discovery_consumes_adapter_ids: false,
  });
}

/**
 * Reconcile discovered site keys against policy map (effect only).
 * Fail closed on unmatched discovered sites and stale policy sites.
 * @param {object} discovery
 * @param {object} policy — { sites: { [site_key]: { effect } } }
 */
function reconcileDiscoveryWithPolicy(discovery, policy) {
  if (!discovery || discovery.ok !== true) {
    return Object.freeze({
      ok: false,
      fail_closed: true,
      code: 'discovery_fail_closed',
      errors: Object.freeze((discovery && discovery.errors) || ['discovery_failed']),
    });
  }
  const policySites = (policy && policy.sites) || {};
  const policyKeys = Object.keys(policySites).sort();
  const discovered = new Set(discovery.site_keys || []);
  const errors = [];

  for (const key of discovery.site_keys || []) {
    if (!Object.prototype.hasOwnProperty.call(policySites, key)) {
      errors.push(`unmatched_discovered_site:${key}`);
    }
  }
  for (const key of policyKeys) {
    if (!discovered.has(key)) {
      errors.push(`stale_policy_site:${key}`);
    }
  }
  // Policy must not be required for discovery — but adapter_id must not be an input to discovery.
  if (policy && policy.discovery_adapter_ids) {
    errors.push('policy_must_not_feed_adapter_ids_to_discovery');
  }

  if (errors.length) {
    return Object.freeze({
      ok: false,
      fail_closed: true,
      code: errors[0].split(':')[0],
      errors: Object.freeze(errors),
    });
  }

  const byEffect = {
    whatsapp_send: [],
    mutation: [],
    read_dispatch: [],
  };
  for (const key of policyKeys) {
    const effect = String(policySites[key].effect || '');
    if (!byEffect[effect]) {
      errors.push(`policy_unknown_effect:${key}:${effect}`);
      continue;
    }
    byEffect[effect].push(key);
  }
  if (errors.length) {
    return Object.freeze({
      ok: false,
      fail_closed: true,
      code: errors[0].split(':')[0],
      errors: Object.freeze(errors),
    });
  }
  for (const k of Object.keys(byEffect)) {
    byEffect[k].sort();
  }

  return Object.freeze({
    ok: true,
    code: 'discovery_policy_reconcile_accepted',
    site_keys: Object.freeze(policyKeys),
    by_effect: Object.freeze({
      whatsapp_send: Object.freeze(byEffect.whatsapp_send),
      mutation: Object.freeze(byEffect.mutation),
      read_dispatch: Object.freeze(byEffect.read_dispatch),
    }),
    counts: Object.freeze({
      whatsapp_send: byEffect.whatsapp_send.length,
      mutation: byEffect.mutation.length,
      read_dispatch: byEffect.read_dispatch.length,
      total: policyKeys.length,
    }),
    scanner_counts: discovery.scanner_counts,
  });
}

module.exports = {
  PYTHON_SCANNER_REL,
  JS_GRAPH_NODES,
  PRIMITIVE_KINDS,
  EXCLUSION_MARKERS,
  siteKey,
  isExcluded,
  discoverJsPhysicalSites,
  discoverPythonPhysicalSites,
  discoverPhysicalSites,
  reconcileDiscoveryWithPolicy,
};
