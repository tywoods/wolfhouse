#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const inspector = require('./check-luna-caddy-json.cjs');
const probe = require('./probe-luna-routing-get.cjs');
const caddyContract = require('../caddy-contract.js');
const controllerModule = require('../../../scripts/luna-number-routing-controller.js');
const fixtures = path.join(__dirname, 'fixtures');
const load = name => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'));
const clone = value => structuredClone(value);
const route = (p, dial, rewrite) => ({ match: [{ host: [inspector.SITE], path: [p] }], handle: [...(rewrite ? [{ handler: 'rewrite', uri: rewrite }] : []), { handler: 'reverse_proxy', upstreams: [{ dial }] }] });
const valid = () => ({ apps: { http: { servers: { one: { routes: [route(inspector.CONTROLLER, '127.0.0.1:8096', inspector.CONTROLLER_REWRITE), route(inspector.PROOF, '127.0.0.1:8094')] } } } } });
let passed = 0;
async function test(name, fn) { try { await fn(); passed++; process.stdout.write(`ok ${passed} - ${name}\n`); } catch (e) { process.stderr.write(`not ok - ${name}: ${e.stack}\n`); process.exitCode = 1; } }
function rejects(mutator) { const cfg = valid(); mutator(cfg); assert.throws(() => inspector.verifyInactiveObject(cfg)); }
(async () => {
 await test('nested inherited routes yield exactly two leaves', () => { const out = inspector.verifyInactiveObject(load('intended-nested.json')); assert.deepStrictEqual(out.leaves, { [inspector.CONTROLLER]: 1, [inspector.PROOF]: 1 }); });
 await test('flat control passes', () => inspector.verifyInactiveObject(load('flat-control.json')));
 await test('delivery/pathless fallback is rejected', () => assert.throws(() => inspector.verifyInactiveObject(load('pathless-webhook-delivery.json'))));
 await test('extra proxy is rejected', () => rejects(c => c.apps.http.servers.one.routes.push(route('/extra', '127.0.0.1:8099'))));
 await test('broad path is rejected', () => rejects(c => c.apps.http.servers.one.routes[1].match[0].path = ['/whatsapp/*']));
 await test('global interception in another server is rejected', () => rejects(c => c.apps.http.servers.two = { routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:8094' }] }] }] }));
 await test('wildcard host interception is rejected', () => rejects(c => { const r = route('/whatsapp/webhook', '127.0.0.1:8094'); r.match[0].host = ['*.lunafrontdesk.com']; c.apps.http.servers.one.routes.push(r); }));
 await test('changed rewrite is rejected', () => rejects(c => c.apps.http.servers.one.routes[0].handle[0].uri = '/changed'));
 await test('changed upstream is rejected', () => rejects(c => c.apps.http.servers.one.routes[1].handle[0].upstreams[0].dial = '127.0.0.1:8095'));
 await test('changed proxy handler fields are rejected', () => rejects(c => c.apps.http.servers.one.routes[1].handle[0].transport = {}));
 await test('additional method matcher is rejected', () => rejects(c => c.apps.http.servers.one.routes[0].match[0].method = ['POST']));
 await test('additional matcher on sequential proxy route is rejected', () => {
   const cfg = valid();
   cfg.apps.http.servers.one.routes[0] = { match: [{ host: [inspector.SITE] }], handle: [{ handler: 'subroute', routes: [
     { match: [{ path: [inspector.CONTROLLER] }], handle: [{ handler: 'rewrite', uri: inspector.CONTROLLER_REWRITE }] },
     { match: [{ path: [inspector.CONTROLLER_REWRITE], method: ['POST'] }], handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:8096' }] }] }
   ] }] };
   assert.throws(() => inspector.verifyInactiveObject(cfg));
 });
 await test('unknown handler is rejected', () => rejects(c => c.apps.http.servers.one.routes[1].handle.unshift({ handler: 'headers' })));
 await test('OR-match bypass is rejected', () => rejects(c => c.apps.http.servers.one.routes[1].match.push({ path: ['/whatsapp/webhook'] })));
 await test('real generator output adapted by Caddy 2.6.2 passes', () => inspector.verifyInactiveObject(load('native-actual-canonical.json')));
 await test('native fixture input is exact production generator output', () => {
   const empty = fs.readFileSync(path.join(fixtures, 'canonical-empty.Caddyfile'), 'utf8');
   const generated = fs.readFileSync(path.join(fixtures, 'canonical-generated.Caddyfile'), 'utf8');
   assert.strictEqual(caddyContract.transform(empty, { site: inspector.SITE }), generated);
 });
 await test('native unmatched proxy with added matcher is rejected', () => {
   const cfg = load('native-actual-canonical.json');
   cfg.apps.http.servers.srv0.routes[0].handle[0].routes[0].handle[0].routes[1].match = [{ method: ['POST'] }];
   assert.throws(() => inspector.verifyInactiveObject(cfg));
 });
 await test('native rewrite group collision with enclosing route is rejected', () => {
   const cfg = load('native-actual-canonical.json');
   const outer = cfg.apps.http.servers.srv0.routes[0].handle[0].routes[0];
   outer.handle[0].routes[0].group = outer.group;
   assert.throws(() => inspector.verifyInactiveObject(cfg), /group collision/);
 });
 await test('native rewrite group consumed by an earlier matching sibling is rejected', () => {
   const cfg = load('native-actual-canonical.json');
   const routes = cfg.apps.http.servers.srv0.routes[0].handle[0].routes[0].handle[0].routes;
   routes.unshift({ group: routes[0].group, handle: [] });
   assert.throws(() => inspector.verifyInactiveObject(cfg), /preceding sibling group collision/);
 });
 await test('native rewrite group consumed by an earlier uppercase-equivalent sibling is rejected', () => {
   const cfg = load('native-actual-canonical.json');
   const routes = cfg.apps.http.servers.srv0.routes[0].handle[0].routes[0].handle[0].routes;
   routes.unshift({ group: routes[0].group, match: [{ path: [inspector.CONTROLLER.toUpperCase()] }], handle: [] });
   assert.throws(() => inspector.verifyInactiveObject(cfg), /preceding sibling group collision/);
 });
 await test('native rewrite group consumed by an earlier placeholder-path sibling is rejected', () => {
   const cfg = load('native-actual-canonical.json');
   const routes = cfg.apps.http.servers.srv0.routes[0].handle[0].routes[0].handle[0].routes;
   routes.unshift({ group: routes[0].group, match: [{ path: ['{http.request.uri.path}'] }], handle: [] });
   assert.throws(() => inspector.verifyInactiveObject(cfg), /preceding sibling group collision/);
 });
 await test('native rewrite group consumed in an earlier nested subroute is rejected', () => {
   const cfg = load('native-actual-canonical.json');
   const routes = cfg.apps.http.servers.srv0.routes[0].handle[0].routes[0].handle[0].routes;
   routes.unshift({ handle: [{ handler: 'subroute', routes: [{ group: routes[0].group, handle: [] }] }] });
   assert.throws(() => inspector.verifyInactiveObject(cfg), /preceding sibling group collision/);
 });
 await test('native rewrite group consumed by an earlier outer grouped route is rejected', () => {
   const cfg = load('native-actual-canonical.json');
   const routes = cfg.apps.http.servers.srv0.routes[0].handle[0].routes[0].handle[0].routes;
   routes.unshift({ group: routes[0].group, handle: [{ handler: 'subroute', routes: [{ handle: [] }] }] });
   assert.throws(() => inspector.verifyInactiveObject(cfg), /preceding sibling group collision/);
 });
 await test('native rewrite group reached after an earlier rewrite is rejected', () => {
   const cfg = load('native-actual-canonical.json');
   const routes = cfg.apps.http.servers.srv0.routes[0].handle[0].routes[0].handle[0].routes;
   routes.unshift({ handle: [{ handler: 'rewrite', uri: '/rewritten-before-group' }, { handler: 'subroute', routes: [{ group: routes[0].group, match: [{ path: ['/rewritten-before-group'] }], handle: [] }] }] });
   assert.throws(() => inspector.verifyInactiveObject(cfg), /preceding sibling group collision/);
 });
 await test('native rewrite group consumed by an earlier empty terminal route is rejected', () => {
   const cfg = load('native-actual-canonical.json');
   const routes = cfg.apps.http.servers.srv0.routes[0].handle[0].routes[0].handle[0].routes;
   routes.unshift({ group: routes[0].group, terminal: true, handle: [] });
   assert.throws(() => inspector.verifyInactiveObject(cfg), /intercepting empty terminal route/);
 });
 await test('native rewrite group reuse by an earlier path-disjoint sibling passes', () => {
   const cfg = load('native-actual-canonical.json');
   const routes = cfg.apps.http.servers.srv0.routes[0].handle[0].routes[0].handle[0].routes;
   routes.unshift({ group: routes[0].group, match: [{ path: ['/different'] }], handle: [] });
   inspector.verifyInactiveObject(cfg);
 });
 await test('native rewrite group reuse by an earlier matching sibling in another group passes', () => {
   const cfg = load('native-actual-canonical.json');
   const routes = cfg.apps.http.servers.srv0.routes[0].handle[0].routes[0].handle[0].routes;
   routes.unshift({ group: 'other-group', handle: [] });
   inspector.verifyInactiveObject(cfg);
 });
 for (const [name, message] of [
   ['lead-outer-group2.json', /preceding sibling group collision/],
   ['lead-ungrouped-terminal.json', /intercepting empty terminal route/],
   ['lead-matched-alias.json', /unapproved or delivery proxy/]
 ]) await test(`Captain exact native lead ${name} is rejected`, () => {
   const cfg = load(name);
   assert.throws(() => inspector.verifyInactiveObject(cfg), message);
   assert.throws(() => inspector.compareProtectedObjects(load('protected-baseline.json'), cfg), message);
 });
 await test('native rewrite/proxy precedence interruption is rejected', () => {
   const cfg = load('native-actual-canonical.json');
   cfg.apps.http.servers.srv0.routes[0].handle[0].routes[0].handle[0].routes.splice(1, 0, { handle: [{ handler: 'static_response', status_code: 204 }] });
   assert.throws(() => inspector.verifyInactiveObject(cfg));
 });
 await test('protected snapshot removes only the intended France addition', () => assert.deepStrictEqual(inspector.snapshotProtectedObject(load('intended-nested.json')), load('protected-baseline.json')));
 await test('protected comparison accepts exact addition', () => inspector.compareProtectedObjects(load('protected-baseline.json'), load('intended-nested.json')));
 for (const [name, mutate] of [
   ['listener', c => c.apps.http.servers.main.listen[0] = ':80'],
   ['server context', c => c.apps.http.servers.main.protocols = ['h1']],
   ['TLS/global', c => c.apps.tls.automation.policies[0].subjects.push('other.example.com')],
   ['wildcard precedence', c => c.apps.http.servers.main.routes.unshift({ match: [{ host: ['*.example.com'] }], handle: [{ handler: 'static_response', status_code: 200 }] })],
   ['protected route precedence', c => c.apps.http.servers.main.routes.unshift({ match: [{ host: ['protected.example.com'] }], handle: [{ handler: 'static_response', status_code: 418 }] })]
 ]) await test(`protected comparison rejects ${name} drift`, () => { const c = load('intended-nested.json'); mutate(c); assert.throws(() => inspector.compareProtectedObjects(load('protected-baseline.json'), c)); });
 await test('canonical HMAC authenticates against real makeHandler', async () => {
   const key = 'k'.repeat(48); const handler = controllerModule.makeHandler({ key, state: async () => { const e = new Error(); e.code = 'route_readback_failed'; throw e; } });
   const server = http.createServer(handler); await new Promise(r => server.listen(0, '127.0.0.1', r));
   try { const got = await probe.request(`http://127.0.0.1:${server.address().port}${controllerModule.ROUTE_PATH}`, key, { deadlineMs: 1000 }); assert.deepStrictEqual(got, { status: 503, body: { ok: false, code: 'route_readback_failed' } }); } finally { await new Promise(r => server.close(r)); }
 });
 await test('helper reads HMAC key from controller env without putting it in argv', () => {
   const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'r4-key-'));
   try {
     const envFile = path.join(dir, 'controller.env');
     fs.writeFileSync(envFile, `LUNA_ROUTING_CONTROLLER_HMAC_KEY=${'z'.repeat(48)}\n`, { mode: 0o600 });
     assert.strictEqual(probe.readKeyFile(envFile), 'z'.repeat(48));
     fs.appendFileSync(envFile, `LUNA_ROUTING_CONTROLLER_HMAC_KEY=${'y'.repeat(48)}\n`);
     assert.throws(() => probe.readKeyFile(envFile), /exactly one/);
   } finally { fs.rmSync(dir, { recursive: true, force: true }); }
 });
 await test('trickle cannot extend absolute deadline', async () => {
   const server = http.createServer((req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); const timer = setInterval(() => res.write(' '), 15); req.on('close', () => clearInterval(timer)); });
   await new Promise(r => server.listen(0, '127.0.0.1', r)); const start = Date.now();
   try { await assert.rejects(probe.request(`http://127.0.0.1:${server.address().port}/`, 'x'.repeat(32), { deadlineMs: 90, idleMs: 50 }), /absolute request deadline exceeded/); assert(Date.now() - start < 500); } finally { await new Promise(r => server.close(r)); }
 });
 await test('response size is bounded', async () => {
   const server = http.createServer((req, res) => res.end('x'.repeat(9000))); await new Promise(r => server.listen(0, '127.0.0.1', r));
   try { await assert.rejects(probe.request(`http://127.0.0.1:${server.address().port}/`, 'x'.repeat(32), { deadlineMs: 1000 }), /response too large/); } finally { await new Promise(r => server.close(r)); }
 });
 await test('synchronous setup failure clears deadline', async () => {
   let set = 0, cleared = 0; const timers = { setTimeout(fn) { set++; return { fn }; }, clearTimeout() { cleared++; } };
   await assert.rejects(probe.request('http://example.invalid/', 'x'.repeat(32), { timers, client: { request() { throw new Error('setup failed'); } } }), /setup failed/); assert.strictEqual(set, 1); assert.strictEqual(cleared, 1);
 });
 if (!process.exitCode) process.stdout.write(`1..${passed}\nPASS ${passed} tests\n`);
})();
