#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const SITE = 'whatsapp-staging.lunafrontdesk.com';
const CONTROLLER = '/_internal/luna-routing/v1/routes/meta-whatsapp-verified-webhook';
const CONTROLLER_REWRITE = '/v1/routes/meta-whatsapp-verified-webhook';
const PROOF = '/whatsapp/routing-proof';
const WEBHOOK = '/whatsapp/webhook';
const APPROVED = new Map([
  [CONTROLLER, { dial: '127.0.0.1:8096', rewrite: CONTROLLER_REWRITE }],
  [PROOF, { dial: '127.0.0.1:8094', rewrite: null }]
]);

function fail(message) { throw new Error(message); }
function patterns(value, key) {
  if (!value || !Object.hasOwn(value, key)) return null;
  if (!Array.isArray(value[key]) || !value[key].length || value[key].some(x => typeof x !== 'string')) fail(`invalid ${key} matcher`);
  return value[key].slice();
}
function glob(pattern, value, host) {
  if (typeof pattern !== 'string') return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', host ? '[^.]+' : '.*');
  return new RegExp(`^${escaped}$`, host ? 'i' : '').test(value);
}
function intersect(a, b, host) {
  if (a === null) return b;
  if (b === null) return a;
  const out = [];
  for (const x of a) for (const y of b) {
    if (x === y) out.push(x);
    else if (glob(x, y, host)) out.push(y);
    else if (glob(y, x, host)) out.push(x);
  }
  return [...new Set(out)];
}
function canMatch(constraint, value, host = false) { return constraint === null || constraint.some(x => glob(x, value, host)); }
function exact(constraint, value) { return Array.isArray(constraint) && constraint.length === 1 && constraint[0] === value; }
function normalizeDial(dial) { return String(dial).replace(/^localhost:/, '127.0.0.1:'); }

function effectiveLeaves(cfg) {
  const servers = cfg?.apps?.http?.servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) fail('missing HTTP servers');
  const leaves = [];
  function routes(list, state) {
    if (!Array.isArray(list)) fail('routes must be an array');
    list.forEach((route, order) => {
      if (!route || typeof route !== 'object' || Array.isArray(route)) fail('invalid route');
      const alternatives = Array.isArray(route.match) && route.match.length ? route.match : [{}];
      alternatives.forEach((match, alternative) => {
        if (!match || typeof match !== 'object' || Array.isArray(match)) fail('invalid match');
        const branch = { ...state, hosts: intersect(state.hosts, patterns(match, 'host'), true), paths: intersect(state.paths, patterns(match, 'path'), false), order: state.order.concat(order), alternative, terminal: route.terminal, group: route.group };
        if (branch.hosts && !branch.hosts.length || branch.paths && !branch.paths.length) return;
        let rewrites = state.rewrites.slice();
        const handlers = Array.isArray(route.handle) ? route.handle : [];
        handlers.forEach((handler, handlerOrder) => {
          if (!handler || typeof handler !== 'object' || Array.isArray(handler) || typeof handler.handler !== 'string') fail('invalid handler');
          if (handler.handler === 'rewrite') {
            if (typeof handler.uri !== 'string' || Object.keys(handler).some(k => !['handler', 'uri'].includes(k))) fail('unsupported rewrite handler');
            rewrites = rewrites.concat(handler.uri);
          } else if (handler.handler === 'subroute') {
            if (Object.keys(handler).some(k => !['handler', 'routes', 'errors'].includes(k)) || handler.errors !== undefined) fail('unsupported subroute handler');
            routes(handler.routes, { ...branch, rewrites: rewrites.slice(), order: branch.order.concat(handlerOrder) });
          } else if (handler.handler === 'reverse_proxy') {
            leaves.push({ ...branch, rewrites: rewrites.slice(), handler, handlerOrder });
          } else if (canMatch(branch.hosts, SITE, true)) {
            fail(`unsupported handler on France branch: ${handler.handler}`);
          }
        });
      });
    });
  }
  for (const [server, value] of Object.entries(servers)) routes(value?.routes || [], { server, hosts: null, paths: null, rewrites: [], order: [] });
  return leaves;
}

function verifyInactiveObject(cfg) {
  const hits = new Map([...APPROVED].map(([path]) => [path, 0]));
  for (const leaf of effectiveLeaves(cfg)) {
    if (!canMatch(leaf.hosts, SITE, true)) continue;
    const possibleApproved = [...APPROVED.keys()].filter(path => canMatch(leaf.paths, path));
    if (canMatch(leaf.paths, WEBHOOK) || !possibleApproved.length) fail(`unapproved or delivery proxy in server ${leaf.server}`);
    if (possibleApproved.length !== 1 || !exact(leaf.hosts, SITE) || !exact(leaf.paths, possibleApproved[0])) fail('broad, wildcard, global, or ambiguous France proxy');
    const path = possibleApproved[0];
    const wanted = APPROVED.get(path);
    const keys = Object.keys(leaf.handler);
    if (keys.some(k => !['handler', 'upstreams'].includes(k))) fail(`changed proxy handler for ${path}`);
    const ups = leaf.handler.upstreams;
    if (!Array.isArray(ups) || ups.length !== 1 || Object.keys(ups[0] || {}).some(k => k !== 'dial') || normalizeDial(ups[0].dial) !== wanted.dial) fail(`changed upstream for ${path}`);
    if (wanted.rewrite === null ? leaf.rewrites.length !== 0 : leaf.rewrites.length !== 1 || leaf.rewrites[0] !== wanted.rewrite) fail(`changed rewrite for ${path}`);
    hits.set(path, hits.get(path) + 1);
  }
  for (const [path, count] of hits) if (count !== 1) fail(`expected exactly one effective proxy leaf for ${path}; got ${count}`);
  return { leaves: Object.fromEntries(hits) };
}

function franceOnly(route) {
  const matches = Array.isArray(route?.match) && route.match.length ? route.match : [{}];
  return matches.every(m => Array.isArray(m.host) && m.host.length === 1 && m.host[0] === SITE);
}
function stripAddition(cfg) {
  const copy = structuredClone(cfg);
  const servers = copy?.apps?.http?.servers || {};
  for (const [name, server] of Object.entries(servers)) if (Array.isArray(server.routes)) {
    server.routes = server.routes.filter(route => !franceOnly(route));
    if (server.routes.length === 0 && Object.keys(server).every(k => k === 'routes')) delete servers[name];
  }
  return copy;
}
function snapshotProtectedObject(cfg) { return stripAddition(cfg); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function compareProtectedObjects(baseline, candidate) {
  verifyInactiveObject(candidate);
  const before = stable(baseline), after = stable(stripAddition(candidate));
  if (before !== after) fail('protected server route/context, TLS/global, or wildcard precedence drift');
  return { digest: crypto.createHash('sha256').update(before).digest('hex') };
}
function load(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function main(argv) {
  if (argv[0] === 'snapshot-protected' && argv.length === 2) return snapshotProtectedObject(load(argv[1]));
  if (argv[0] === 'verify-inactive' && argv.length === 2) return verifyInactiveObject(load(argv[1]));
  if (argv[0] === 'compare-protected' && argv.length === 3) return compareProtectedObjects(load(argv[1]), load(argv[2]));
  fail('usage: check-luna-caddy-json.cjs verify-inactive FILE | compare-protected BASELINE CANDIDATE');
}
if (require.main === module) {
  try { const argv = process.argv.slice(2); const result = main(argv); process.stdout.write(argv[0] === 'snapshot-protected' ? `${JSON.stringify(result)}\n` : `PASS ${JSON.stringify(result)}\n`); }
  catch (error) { process.stderr.write(`FAIL ${error.message}\n`); process.exitCode = 1; }
}
module.exports = { SITE, CONTROLLER, CONTROLLER_REWRITE, PROOF, WEBHOOK, effectiveLeaves, verifyInactiveObject, compareProtectedObjects, stripAddition, snapshotProtectedObject };
