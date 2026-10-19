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
  return new RegExp(`^${escaped}$`, 'i').test(value);
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
    function nativeStaticMatch(pattern, value, host) {
      if (typeof pattern !== 'string' || /[?\[\]{}%\\]/.test(pattern)) return null;
      const escaped = pattern.replace(/[.+^$()|[\]\\]/g, '\\$&').replaceAll('*', host ? '[^.]+' : '.*');
      return new RegExp(`^${escaped}$`, 'i').test(value);
    }
    function alternativeMayApply(match, host, requestPath) {
      if (!match || typeof match !== 'object' || Array.isArray(match)) return true;
      if (Object.keys(match).some(key => !['host', 'path'].includes(key))) return true;
      const hosts = patterns(match, 'host');
      const paths = patterns(match, 'path');
      const hostApplies = hosts === null || hosts.some(pattern => nativeStaticMatch(pattern, host, true) !== false);
      const pathApplies = paths === null || paths.some(pattern => nativeStaticMatch(pattern, requestPath, false) !== false);
      return hostApplies && pathApplies;
    }
    function hasEscapingRewrite(list, host, requestPath) {
      if (!Array.isArray(list)) return true;
      for (let i = 0; i < list.length; i++) {
        const route = list[i], next = list[i + 1];
        if (!route || typeof route !== 'object' || Array.isArray(route)) return true;
        const alternatives = Array.isArray(route.match) && route.match.length ? route.match : [{}];
        if (!alternatives.some(match => alternativeMayApply(match, host, requestPath))) continue;
        const handlers = Array.isArray(route.handle) ? route.handle : [];
        const directRewrite = handlers.length === 1 && handlers[0]?.handler === 'rewrite' ? handlers[0] : null;
        const nextProxy = Array.isArray(next?.handle) && next.handle.length === 1 && next.handle[0]?.handler === 'reverse_proxy';
        const supportedPair = directRewrite?.uri === CONTROLLER_REWRITE && nextProxy && next.match === undefined
          && typeof route.group === 'string' && Object.keys(route).every(key => ['group', 'handle'].includes(key))
          && Object.keys(next).every(key => key === 'handle');
        if (supportedPair) { i++; continue; }
        for (const handler of handlers) {
          if (handler?.handler === 'rewrite') return true;
          if (handler?.handler === 'subroute' && hasEscapingRewrite(handler.routes, host, requestPath)) return true;
        }
      }
      return false;
    }
    function handlersMayConsumeGroup(handlers, group, host, requestPath) {
      let currentPath = requestPath;
      for (const handler of handlers) {
        if (!handler || typeof handler !== 'object' || Array.isArray(handler)) return true;
        if (handler.handler === 'rewrite') {
          if (typeof handler.uri !== 'string' || handler.uri.includes('{')) return true;
          currentPath = handler.uri;
        } else if (handler.handler === 'subroute') {
          if (!Array.isArray(handler.routes)
            || hasEscapingRewrite(handler.routes, host, currentPath)
            || handler.routes.some(child => routeMayConsumeGroup(child, group, host, currentPath))) return true;
        }
      }
      return false;
    }
    function routeMayConsumeGroup(route, group, host, requestPath) {
      if (!route || typeof route !== 'object' || Array.isArray(route)) return true;
      const alternatives = Array.isArray(route.match) && route.match.length ? route.match : [{}];
      return alternatives.some(match => {
        if (!alternativeMayApply(match, host, requestPath)) return false;
        if (route.group === group) return true;
        let currentPath = requestPath;
        const handlers = Array.isArray(route.handle) ? route.handle : [];
        for (const handler of handlers) {
          if (!handler || typeof handler !== 'object' || Array.isArray(handler)) return true;
          if (handler.handler === 'rewrite') {
            if (typeof handler.uri !== 'string' || handler.uri.includes('{')) return true;
            currentPath = handler.uri;
          } else if (handler.handler === 'subroute') {
            if (!Array.isArray(handler.routes) || handler.routes.some(child => routeMayConsumeGroup(child, group, host, currentPath))) return true;
          }
        }
        return false;
      });
    }
    function routeGroups(route, out = new Set()) {
      if (!route || typeof route !== 'object' || Array.isArray(route)) return out;
      if (typeof route.group === 'string') out.add(route.group);
      if (!Array.isArray(route.handle)) return out;
      for (const handler of route.handle) {
        if (handler?.handler === 'subroute' && Array.isArray(handler.routes)) {
          for (const child of handler.routes) routeGroups(child, out);
        }
      }
      return out;
    }
    const consumedBefore = new Map();
    const normalized = [];
    for (let i = 0; i < list.length; i++) {
      const route = list[i], next = list[i + 1];
      const routeAlternatives = Array.isArray(route?.match) && route.match.length ? route.match : [{}];
      const relevantApproved = [...APPROVED.keys()].filter(requestPath =>
        routeAlternatives.some(match => alternativeMayApply(match, SITE, requestPath)));
      const priorConsumed = new Set(state.consumedGroups);
      for (const group of routeGroups(route)) {
        if (relevantApproved.some(requestPath =>
          list.slice(0, i).some(sibling => routeMayConsumeGroup(sibling, group, SITE, requestPath)))) {
          priorConsumed.add(group);
        }
      }
      consumedBefore.set(route, priorConsumed);
      if (typeof route?.group === 'string' && relevantApproved.some(requestPath =>
        list.slice(0, i).some(sibling => routeMayConsumeGroup(sibling, route.group, SITE, requestPath)))) {
        fail('preceding sibling group collision');
      }
      const handlers = Array.isArray(route?.handle) ? route.handle : [];
      if (route?.terminal === true && handlers.length === 0 && relevantApproved.length) {
        fail('intercepting empty terminal route');
      }
      const rewrite = handlers.length === 1 && handlers[0]?.handler === 'rewrite' ? handlers[0] : null;
      const nextProxy = Array.isArray(next?.handle) && next.handle.length === 1 && next.handle[0]?.handler === 'reverse_proxy' ? next.handle[0] : null;
      const rewritePath = rewrite?.uri;
      const sequentialShape = rewrite && nextProxy && rewritePath === CONTROLLER_REWRITE && exact(state.paths, CONTROLLER)
        && next.match === undefined && typeof route.group === 'string'
        && Object.keys(route).every(key => ['group', 'handle'].includes(key))
        && Object.keys(next).every(key => key === 'handle');
      const nativeSequential = sequentialShape && !state.groups.includes(route.group) && !state.consumedGroups.includes(route.group);
      if (nativeSequential) {
        if (route.terminal || next.terminal || next.group) fail('unsupported sequential rewrite control');
        const combined = { ...route, handle: [rewrite, nextProxy] };
        consumedBefore.set(combined, priorConsumed);
        normalized.push(combined); i++; continue;
      }
      const affectedApproved = relevantApproved.filter(requestPath => list.slice(i + 1).some(sibling => {
        const alternatives = Array.isArray(sibling?.match) && sibling.match.length ? sibling.match : [{}];
        return alternatives.some(match => alternativeMayApply(match, SITE, requestPath));
      }));
      if (affectedApproved.length) {
        if (route?.terminal === true) fail(handlers.length === 0 ? 'intercepting empty terminal route' : 'preceding route termination effect');
        const hasUnresolvedRewrite = affectedApproved.some(requestPath => handlers.some(handler =>
          handler?.handler === 'rewrite' && !sequentialShape
          || handler?.handler === 'subroute' && hasEscapingRewrite(handler.routes, SITE, requestPath)));
        if (hasUnresolvedRewrite) fail('preceding route rewrite effect');
      }
      normalized.push(route);
    }
    normalized.forEach((route, order) => {
      if (!route || typeof route !== 'object' || Array.isArray(route)) fail('invalid route');
      const alternatives = Array.isArray(route.match) && route.match.length ? route.match : [{}];
      alternatives.forEach((match, alternative) => {
        if (!match || typeof match !== 'object' || Array.isArray(match)) fail('invalid match');
        if (Object.keys(match).some(key => !['host', 'path'].includes(key))) fail('unsupported matcher constraint');
        if (typeof route.group === 'string' && state.groups.includes(route.group)) fail('nested route group collision');
        const matchedCurrentPaths = intersect(state.currentPaths, patterns(match, 'path'), false);
        const incomingPaths = state.rewrites.length ? state.paths : intersect(state.paths, patterns(match, 'path'), false);
        const branch = { ...state, hosts: intersect(state.hosts, patterns(match, 'host'), true), paths: incomingPaths, currentPaths: matchedCurrentPaths, order: state.order.concat(order), alternative, terminal: route.terminal, group: route.group, groups: typeof route.group === 'string' ? state.groups.concat(route.group) : state.groups, consumedGroups: [...consumedBefore.get(route)] };
        if (branch.hosts && !branch.hosts.length || branch.paths && !branch.paths.length || branch.currentPaths && !branch.currentPaths.length) return;
        let rewrites = state.rewrites.slice();
        let currentPaths = branch.currentPaths;
        const handlers = Array.isArray(route.handle) ? route.handle : [];
        handlers.forEach((handler, handlerOrder) => {
          if (!handler || typeof handler !== 'object' || Array.isArray(handler) || typeof handler.handler !== 'string') fail('invalid handler');
          if (handler.handler === 'rewrite') {
            if (typeof handler.uri !== 'string' || Object.keys(handler).some(k => !['handler', 'uri'].includes(k))) fail('unsupported rewrite handler');
            rewrites = rewrites.concat(handler.uri);
            currentPaths = [handler.uri];
          } else if (handler.handler === 'subroute') {
            if (Object.keys(handler).some(k => !['handler', 'routes', 'errors'].includes(k)) || handler.errors !== undefined) fail('unsupported subroute handler');
            const possibleApproved = [...APPROVED.keys()].filter(requestPath => canMatch(branch.paths, requestPath));
            for (const group of (handler.routes || []).flatMap(child => [...routeGroups(child)])) {
              if (possibleApproved.some(requestPath => handlersMayConsumeGroup(handlers.slice(0, handlerOrder), group, SITE, requestPath))) {
                fail('preceding handler group collision');
              }
            }
            const returnPaths = currentPaths === null ? possibleApproved : currentPaths;
            if (handlerOrder < handlers.length - 1
              && returnPaths.some(requestPath => hasEscapingRewrite(handler.routes, SITE, requestPath))) {
              fail('nested subroute rewrite effect reaches later handler');
            }
            routes(handler.routes, { ...branch, currentPaths, rewrites: rewrites.slice(), order: branch.order.concat(handlerOrder) });
          } else if (handler.handler === 'reverse_proxy') {
            leaves.push({ ...branch, rewrites: rewrites.slice(), handler, handlerOrder });
          } else if (canMatch(branch.hosts, SITE, true)) {
            fail(`unsupported handler on France branch: ${handler.handler}`);
          }
        });
      });
    });
  }
  for (const [server, value] of Object.entries(servers)) routes(value?.routes || [], { server, hosts: null, paths: null, currentPaths: null, rewrites: [], order: [], groups: [], consumedGroups: [] });
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
