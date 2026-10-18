'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const here = __dirname;
const { parseSimulation } = require('./parse-apt-simulation.cjs');
const { enumerate, restoreAtomic, verifyRestore } = require('./caddy-import-inventory.cjs');

const positive = 'Inst nodejs (22.23.3-1nodesource1 local-deb [amd64])\nConf nodejs (22.23.3-1nodesource1 local-deb [amd64])\n';
assert.deepEqual(parseSimulation(positive), [{ action: 'install', package: 'nodejs', version: '22.23.3-1nodesource1', architecture: 'amd64' }]);
for (const bad of [
  positive + 'Inst libc6 (2.36 repo [amd64])\nConf libc6 (2.36 repo [amd64])\n',
  'Remv nodejs [20.0.0]\n',
  'Inst nodejs [20.0.0] (22.23.3-1nodesource1 local [amd64])\n',
  'Inst nodejs (22.23.3-1nodesource1 local [amd64])\n',
  'Conf other (1 repo [amd64])\n',
]) assert.throws(() => parseSimulation(bad));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-inventory-'));
const root = path.join(tmp, 'etc', 'caddy'); fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
const main = path.join(root, 'Caddyfile'); const imported = path.join(root, 'sub', 'routes.caddy');
fs.writeFileSync(main, 'import sub/routes.caddy\n'); fs.writeFileSync(imported, 'example.test { respond "ok" }\n');
const before = enumerate(main, root); assert.equal(before.length, 2);
const untouchedInode = fs.statSync(imported).ino; const oldRootInode = fs.statSync(main).ino;
const backup = path.join(tmp, 'backup'); fs.mkdirSync(backup); fs.cpSync(main, path.join(backup, 'Caddyfile'), { preserveTimestamps: true });
fs.writeFileSync(main, 'changed\n'); restoreAtomic(path.join(backup, 'Caddyfile'), main);
assert.notEqual(fs.statSync(main).ino, oldRootInode); verifyRestore(before, enumerate(main, root), new Set(['Caddyfile']));
assert.equal(fs.statSync(imported).ino, untouchedInode);
for (const mutate of [
  () => fs.writeFileSync(imported, 'drift\n'),
  () => fs.chmodSync(imported, 0o600),
  () => fs.rmSync(imported),
  () => { fs.rmSync(imported); fs.symlinkSync('/dev/null', imported); },
]) {
  try { mutate(); assert.throws(() => verifyRestore(before, enumerate(main, root), new Set(['Caddyfile']))); }
  finally { fs.rmSync(imported, { force: true }); fs.writeFileSync(imported, 'example.test { respond "ok" }\n'); fs.chmodSync(imported, 0o644); }
}
const shell = path.join(here, 'run-luna-routing-r4.sh');
assert.equal(cp.spawnSync('bash', ['-n', shell]).status, 0);
const source = fs.readFileSync(shell, 'utf8');
assert.match(source, /trap on_exit EXIT/); assert.match(source, /CONTROLLER_STOP_UNCONFIRMED/); assert.match(source, /rollback_caddy/);
const beforeNodeInstall = source.slice(source.indexOf('exec 9>'), source.indexOf('PHASE=node'));
assert.doesNotMatch(beforeNodeInstall, /(^|[;&|]\s*)node\s/m, 'absent-Node preflight/inventory must not invoke Node');
assert.doesNotMatch(beforeNodeInstall, /for x in [^\n]*\bnode\b/, 'preflight must not require Node');
assert.match(source, /verify_apt_simulation_shell/);
assert.match(source, /rollback_all\(\).*verify_full_baseline.*rollback_node/, 'baseline verification must precede Node purge');
console.log('PASS R4 inventory, atomic restoration, apt parser, and transaction contracts');
