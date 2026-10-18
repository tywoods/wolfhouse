#!/usr/bin/env node
'use strict';
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const inspector = require('./check-luna-caddy-json.cjs');

const caddy = process.env.CADDY_BIN;
if (!caddy) throw new Error('CADDY_BIN must point to the reviewed Caddy 2.6.2 binary');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/native-actual-canonical.json'), 'utf8'));
const controllerRoutes = cfg => cfg.apps.http.servers.srv0.routes[0].handle[0].routes[0].handle[0].routes;
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = server => new Promise(resolve => server.close(resolve));
async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}
async function request(port, requestPath = inspector.CONTROLLER, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers: { host: inspector.SITE }, timeout: 2000 }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}
async function runCase(root, name, mutate, expectedPath, inspectorRejects, expectedStatus = 204) {
  const seen = [];
  const cfg = structuredClone(fixture);
  mutate(controllerRoutes(cfg));
  if (inspectorRejects) assert.throws(() => inspector.verifyInactiveObject(cfg), /preceding sibling group collision|intercepting empty terminal route|preceding route (?:rewrite|termination) effect/);
  else inspector.verifyInactiveObject(cfg);
  const upstream = http.createServer((req, res) => { seen.push(req.url); res.writeHead(204); res.end(); });
  const upstreamPort = await listen(upstream);
  const listenPort = await freePort();
  cfg.admin = { disabled: true };
  cfg.apps.http.servers.srv0.automatic_https = { disable: true };
  cfg.apps.http.servers.srv0.listen = [`127.0.0.1:${listenPort}`];
  controllerRoutes(cfg)[controllerRoutes(cfg).length - 1].handle[0].upstreams[0].dial = `127.0.0.1:${upstreamPort}`;
  const config = path.join(root, `${name}.json`);
  const stdout = fs.openSync(path.join(root, `${name}.stdout.log`), 'w');
  const stderr = fs.openSync(path.join(root, `${name}.stderr.log`), 'w');
  fs.writeFileSync(config, `${JSON.stringify(cfg, null, 2)}\n`);
  const child = cp.spawn(caddy, ['run', '--config', config], {
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, `${name}-config`), XDG_DATA_HOME: path.join(root, `${name}-data`) },
    stdio: ['ignore', stdout, stderr]
  });
  try {
    let status;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null) throw new Error(`Caddy exited ${child.exitCode} in ${name}`);
      try { status = await request(listenPort); break; } catch { await new Promise(resolve => setTimeout(resolve, 40)); }
    }
    assert.strictEqual(status, expectedStatus, `${name} response`);
    assert.deepStrictEqual(seen, expectedPath === null ? [] : [expectedPath], `${name} upstream URI`);
  } finally {
    child.kill('SIGTERM');
    const exit = await new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    fs.closeSync(stdout); fs.closeSync(stderr);
    await close(upstream);
    assert.deepStrictEqual(exit, { code: 0, signal: null }, `${name} Caddy exit`);
  }
  return { name, inspector: inspectorRejects ? 'REJECT' : 'PASS', upstreamPath: seen[0] };
}
function replaceDials(value, controllerDial, proofDial) {
  if (Array.isArray(value)) return value.forEach(item => replaceDials(item, controllerDial, proofDial));
  if (!value || typeof value !== 'object') return;
  if (value.dial === '127.0.0.1:8096') value.dial = controllerDial;
  if (value.dial === '127.0.0.1:8094') value.dial = proofDial;
  for (const child of Object.values(value)) replaceDials(child, controllerDial, proofDial);
}
async function runExactLead(root, name, expectedController, expectedProof, expectedAlias, inspectorRejects = true) {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8'));
  if (inspectorRejects) assert.throws(() => inspector.verifyInactiveObject(cfg));
  else inspector.verifyInactiveObject(cfg);
  const controllerSeen = [], proofSeen = [];
  const controllerUpstream = http.createServer((req, res) => { controllerSeen.push(req.url); res.writeHead(204); res.end(); });
  const proofUpstream = http.createServer((req, res) => { proofSeen.push(req.url); res.writeHead(204); res.end(); });
  const controllerPort = await listen(controllerUpstream);
  const proofPort = await listen(proofUpstream);
  const listenPort = await freePort();
  replaceDials(cfg, `127.0.0.1:${controllerPort}`, `127.0.0.1:${proofPort}`);
  cfg.admin = { disabled: true };
  cfg.apps.http.servers.srv0.automatic_https = { disable: true };
  cfg.apps.http.servers.srv0.listen = [`127.0.0.1:${listenPort}`];
  const config = path.join(root, `${name}.json`);
  const stdout = fs.openSync(path.join(root, `${name}.stdout.log`), 'w');
  const stderr = fs.openSync(path.join(root, `${name}.stderr.log`), 'w');
  fs.writeFileSync(config, `${JSON.stringify(cfg, null, 2)}\n`);
  const child = cp.spawn(caddy, ['run', '--config', config], {
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, `${name}-config`), XDG_DATA_HOME: path.join(root, `${name}-data`) },
    stdio: ['ignore', stdout, stderr]
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null) throw new Error(`Caddy exited ${child.exitCode} in ${name}`);
      try { await request(listenPort, '/ready-probe'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 40)); }
    }
    assert(ready, `${name} Caddy readiness`);
    await request(listenPort, inspector.CONTROLLER);
    await request(listenPort, inspector.PROOF);
    await request(listenPort, inspector.CONTROLLER_REWRITE);
    assert.deepStrictEqual(controllerSeen, expectedController, `${name} controller upstream calls`);
    assert.deepStrictEqual(proofSeen, expectedProof, `${name} proof upstream calls`);
    const aliasSeen = controllerSeen.filter(uri => uri === inspector.CONTROLLER_REWRITE).length;
    assert.strictEqual(aliasSeen, expectedAlias, `${name} direct alias reachability`);
  } finally {
    child.kill('SIGTERM');
    const exit = await new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    fs.closeSync(stdout); fs.closeSync(stderr);
    await close(controllerUpstream); await close(proofUpstream);
    assert.deepStrictEqual(exit, { code: 0, signal: null }, `${name} Caddy exit`);
  }
  return { name, inspector: inspectorRejects ? 'REJECT' : 'PASS', controllerSeen, proofSeen };
}
async function runCaptainR8(root, name, inspectorRejects, expectedCalls) {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8'));
  if (inspectorRejects) assert.throws(() => inspector.verifyInactiveObject(cfg));
  else inspector.verifyInactiveObject(cfg);
  const seen = [];
  const upstream = http.createServer((req, res) => { seen.push({ method: req.method, url: req.url }); res.writeHead(204); res.end(); });
  const upstreamPort = await listen(upstream);
  const listenPort = await freePort();
  replaceDials(cfg, `127.0.0.1:${upstreamPort}`, `127.0.0.1:${upstreamPort}`);
  cfg.admin = { disabled: true };
  cfg.apps.http.servers.srv0.automatic_https = { disable: true };
  cfg.apps.http.servers.srv0.listen = [`127.0.0.1:${listenPort}`];
  const config = path.join(root, `${name}.json`);
  const stdout = fs.openSync(path.join(root, `${name}.stdout.log`), 'w');
  const stderr = fs.openSync(path.join(root, `${name}.stderr.log`), 'w');
  fs.writeFileSync(config, `${JSON.stringify(cfg, null, 2)}\n`);
  const child = cp.spawn(caddy, ['run', '--config', config], {
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, `${name}-config`), XDG_DATA_HOME: path.join(root, `${name}-data`) },
    stdio: ['ignore', stdout, stderr]
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (child.exitCode !== null) throw new Error(`Caddy exited ${child.exitCode} in ${name}`);
      try { await request(listenPort, '/ready-probe'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 40)); }
    }
    assert(ready, `${name} Caddy readiness`);
    await request(listenPort, inspector.CONTROLLER);
    await request(listenPort, inspector.PROOF);
    await request(listenPort, inspector.WEBHOOK, 'GET');
    await request(listenPort, inspector.WEBHOOK, 'POST');
    assert.deepStrictEqual(seen, expectedCalls, `${name} native upstream calls`);
  } finally {
    child.kill('SIGTERM');
    const exit = await new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    fs.closeSync(stdout); fs.closeSync(stderr);
    await close(upstream);
    assert.deepStrictEqual(exit, { code: 0, signal: null }, `${name} Caddy exit`);
  }
  return { name, inspector: inspectorRejects ? 'REJECT' : 'PASS', seen };
}
(async () => {
  const version = cp.execFileSync(caddy, ['version'], { encoding: 'utf8' }).trim();
  assert.match(version, /^v2\.6\.2\b/, 'native regression requires exact Caddy 2.6.2');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-r6-native-'));
  const cases = [
    await runCase(root, 'authentic-control', () => {}, inspector.CONTROLLER_REWRITE, false),
    await runCase(root, 'earlier-different-group', routes => routes.unshift({ group: 'other-group', handle: [] }), inspector.CONTROLLER_REWRITE, false),
    await runCase(root, 'earlier-same-group-nonmatching', routes => routes.unshift({ group: routes[0].group, match: [{ path: ['/different'] }], handle: [] }), inspector.CONTROLLER_REWRITE, false),
    await runCase(root, 'earlier-same-group-alias-disjoint-rewrite', routes => routes.unshift({ group: routes[0].group, match: [{ path: ['/alias'] }], handle: [{ handler: 'rewrite', uri: inspector.CONTROLLER }] }), inspector.CONTROLLER_REWRITE, false),
    await runCase(root, 'earlier-same-group-matching', routes => routes.unshift({ group: routes[0].group, handle: [] }), inspector.CONTROLLER, true),
    await runCase(root, 'earlier-same-group-uppercase-path', routes => routes.unshift({ group: routes[0].group, match: [{ path: [inspector.CONTROLLER.toUpperCase()] }], handle: [] }), inspector.CONTROLLER, true),
    await runCase(root, 'earlier-same-group-placeholder-path', routes => routes.unshift({ group: routes[0].group, match: [{ path: ['{http.request.uri.path}'] }], handle: [] }), inspector.CONTROLLER, true),
    await runCase(root, 'earlier-nested-same-group', routes => routes.unshift({ handle: [{ handler: 'subroute', routes: [{ group: routes[0].group, handle: [] }] }] }), inspector.CONTROLLER, true),
    await runCase(root, 'earlier-outer-same-group', routes => routes.unshift({ group: routes[0].group, handle: [{ handler: 'subroute', routes: [{ handle: [] }] }] }), inspector.CONTROLLER, true),
    await runCase(root, 'earlier-rewrite-reaches-same-group', routes => routes.unshift({ handle: [{ handler: 'rewrite', uri: '/rewritten-before-group' }, { handler: 'subroute', routes: [{ group: routes[0].group, match: [{ path: ['/rewritten-before-group'] }], handle: [] }] }] }), '/rewritten-before-group', true),
    await runCase(root, 'earlier-empty-terminal-same-group', routes => routes.unshift({ group: routes[0].group, terminal: true, handle: [] }), null, true, 200),
    await runExactLead(root, 'lead-outer-group2', [], [], 0),
    await runExactLead(root, 'lead-ungrouped-terminal', [], [inspector.PROOF], 0),
    await runExactLead(root, 'lead-matched-alias', [inspector.CONTROLLER_REWRITE, inspector.CONTROLLER_REWRITE], [inspector.PROOF], 2),
    await runExactLead(root, 'terminal-inert-subroute', [], [inspector.PROOF], 0),
    await runExactLead(root, 'nonterminal-inert-subroute-control', [inspector.CONTROLLER_REWRITE], [inspector.PROOF], 1, false),
    await runExactLead(root, 'preceding-rewrite', [], [inspector.PROOF], 0),
    await runExactLead(root, 'preceding-disjoint-rewrite-control', [inspector.CONTROLLER_REWRITE], [inspector.PROOF], 1, false),
    await runExactLead(root, 'nested-preceding-rewrite', [], [inspector.PROOF], 0),
    await runExactLead(root, 'nested-preceding-disjoint-rewrite-control', [inspector.CONTROLLER_REWRITE], [inspector.PROOF], 1, false),
    await runCaptainR8(root, 'cross-scope-group-consumer', true, [
      { method: 'GET', url: inspector.CONTROLLER },
      { method: 'GET', url: inspector.PROOF }
    ]),
    await runCaptainR8(root, 'cross-scope-disjoint-control', false, [
      { method: 'GET', url: inspector.CONTROLLER_REWRITE },
      { method: 'GET', url: inspector.PROOF }
    ]),
    await runCaptainR8(root, 'cross-handler-consumer', true, [
      { method: 'GET', url: inspector.CONTROLLER },
      { method: 'GET', url: inspector.PROOF }
    ]),
    await runCaptainR8(root, 'cross-handler-disjoint-control', false, [
      { method: 'GET', url: inspector.CONTROLLER_REWRITE },
      { method: 'GET', url: inspector.PROOF }
    ]),
    await runCaptainR8(root, 'cross-handler-different-group-control', false, [
      { method: 'GET', url: inspector.CONTROLLER_REWRITE },
      { method: 'GET', url: inspector.PROOF }
    ]),
    await runCaptainR8(root, 'uppercase-nested-delivery', true, [
      { method: 'GET', url: inspector.CONTROLLER_REWRITE },
      { method: 'GET', url: inspector.PROOF },
      { method: 'GET', url: inspector.WEBHOOK },
      { method: 'POST', url: inspector.WEBHOOK }
    ]),
    await runCaptainR8(root, 'lowercase-nested-delivery-rejection-control', true, [
      { method: 'GET', url: inspector.CONTROLLER_REWRITE },
      { method: 'GET', url: inspector.PROOF },
      { method: 'GET', url: inspector.WEBHOOK },
      { method: 'POST', url: inspector.WEBHOOK }
    ]),
    await runCaptainR8(root, 'disjoint-nested-delivery-control', false, [
      { method: 'GET', url: inspector.CONTROLLER_REWRITE },
      { method: 'GET', url: inspector.PROOF }
    ])
  ];
  fs.writeFileSync(path.join(root, 'results.json'), `${JSON.stringify({ version, cases }, null, 2)}\n`);
  process.stdout.write(`PASS native Caddy routing regression ${root}\n${JSON.stringify(cases)}\n`);
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
