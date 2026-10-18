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
async function request(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: inspector.CONTROLLER, headers: { host: inspector.SITE }, timeout: 2000 }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
  });
}
async function runCase(root, name, mutate, expectedPath, inspectorRejects) {
  const seen = [];
  const cfg = structuredClone(fixture);
  mutate(controllerRoutes(cfg));
  if (inspectorRejects) assert.throws(() => inspector.verifyInactiveObject(cfg), /preceding sibling group collision/);
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
    assert.strictEqual(status, 204, `${name} response`);
    assert.deepStrictEqual(seen, [expectedPath], `${name} upstream URI`);
  } finally {
    child.kill('SIGTERM');
    const exit = await new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    fs.closeSync(stdout); fs.closeSync(stderr);
    await close(upstream);
    assert.deepStrictEqual(exit, { code: 0, signal: null }, `${name} Caddy exit`);
  }
  return { name, inspector: inspectorRejects ? 'REJECT' : 'PASS', upstreamPath: seen[0] };
}
(async () => {
  const version = cp.execFileSync(caddy, ['version'], { encoding: 'utf8' }).trim();
  assert.match(version, /^v2\.6\.2\b/, 'native regression requires exact Caddy 2.6.2');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-r5-native-'));
  const cases = [
    await runCase(root, 'authentic-control', () => {}, inspector.CONTROLLER_REWRITE, false),
    await runCase(root, 'earlier-different-group', routes => routes.unshift({ group: 'other-group', handle: [] }), inspector.CONTROLLER_REWRITE, false),
    await runCase(root, 'earlier-same-group-nonmatching', routes => routes.unshift({ group: routes[0].group, match: [{ path: ['/different'] }], handle: [] }), inspector.CONTROLLER_REWRITE, false),
    await runCase(root, 'earlier-same-group-matching', routes => routes.unshift({ group: routes[0].group, handle: [] }), inspector.CONTROLLER, true)
  ];
  fs.writeFileSync(path.join(root, 'results.json'), `${JSON.stringify({ version, cases }, null, 2)}\n`);
  process.stdout.write(`PASS native Caddy sibling-group regression ${root}\n${JSON.stringify(cases)}\n`);
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
