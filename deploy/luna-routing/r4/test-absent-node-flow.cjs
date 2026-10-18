#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const here = __dirname;
const hostNode = process.execPath;
function writeExecutable(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode: 0o755 }); }
function run(command, args, opts = {}) { const out = cp.spawnSync(command, args, { encoding: 'utf8', ...opts }); if (out.error) throw out.error; return out; }
function sha(file) { return run('sha256sum', [file]).stdout.split(/\s+/)[0]; }
function makeArchive(root, failInstall) {
  const tree = path.join(root, failInstall ? 'source-fail' : 'source-ok');
  const source = path.join(tree, 'source');
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(source, 'deploy/luna-routing'), { recursive: true });
  fs.writeFileSync(path.join(source, 'SOURCE_COMMIT'), 'fixture-commit\n');
  fs.writeFileSync(path.join(source, 'scripts/verify-luna-routing-deployment.js'), "console.log('fixture source verified');\n");
  writeExecutable(path.join(source, 'deploy/luna-routing/install-luna-routing.sh'), `#!/usr/bin/env bash\nprintf 'INSTALLER %s\\n' "$1" >>"$R4_TEST_LOG"\n${failInstall ? '[[ $1 != --install ]] || exit 42' : ':'}\n`);
  const archive = path.join(root, failInstall ? 'source-fail.tar' : 'source-ok.tar');
  assert.equal(run('tar', ['-cf', archive, '-C', tree, 'source']).status, 0);
  return archive;
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-absent-node-'));
  const bundle = path.join(root, 'bundle'); fs.cpSync(here, bundle, { recursive: true });
  for (const p of ['etc/caddy', 'var/lib/caddy/.config/caddy', 'var/backups', 'root', 'opt/luna-routing', 'etc/luna-routing', 'etc/systemd/system', 'etc/sudoers.d', 'etc/tmpfiles.d', 'run/lock', 'usr/bin', 'bin', 'tx']) fs.mkdirSync(path.join(root, p), { recursive: true });
  fs.writeFileSync(path.join(root, 'etc/caddy/Caddyfile'), 'fixture.test { respond "ok" }\n');
  fs.copyFileSync(path.join(here, 'fixtures/intended-nested.json'), path.join(root, 'var/lib/caddy/.config/caddy/autosave.json'));
  fs.writeFileSync(path.join(root, 'root/luna-routing.env'), 'fixture\n', { mode: 0o600 });
  const deb = path.join(root, 'nodejs.deb'); fs.writeFileSync(deb, 'pinned fixture deb\n');
  const log = path.join(root, 'operations.log'); fs.writeFileSync(log, '');
  const mock = (name, body) => writeExecutable(path.join(root, 'bin', name), `#!/usr/bin/env bash\nset -u\n${body}\n`);
  mock('flock', 'exit 0');
  mock('dpkg-query', 'exit 1');
  mock('curl', 'exit 22');
  mock('docker', `printf 'DOCKER %s\\n' "$*" >>"$R4_TEST_LOG"\nif [[ $1 == ps ]]; then echo crowsnest-fixture; else echo 'container-fixture image-fixture true'; fi`);
  mock('caddy', `printf 'CADDY %s\\n' "$*" >>"$R4_TEST_LOG"`);
  mock('apt-get', `printf 'APT %s\\n' "$*" >>"$R4_TEST_LOG"
if [[ $1 == -s ]]; then printf 'Inst nodejs (22.23.3-1nodesource1 local-deb [amd64])\\nConf nodejs (22.23.3-1nodesource1 local-deb [amd64])\\n'; exit 0; fi
if [[ $1 == install ]]; then
  cat >"$R4_ROOT/usr/bin/node" <<'NODE'
#!/usr/bin/env bash
if [[ \${1:-} == --version ]]; then echo v22.23.3; else exec "\${R4_HOST_NODE:?}" "$@"; fi
NODE
  chmod 755 "$R4_ROOT/usr/bin/node"; exit 0
fi
if [[ $1 == purge ]]; then [[ $* == 'purge -y nodejs' ]] || exit 91; rm -f "$R4_ROOT/usr/bin/node"; exit 0; fi
[[ $1 == update ]]`);
  writeExecutable(path.join(root, 'usr/bin/systemctl'), `#!/usr/bin/env bash\nprintf 'SYSTEMCTL %s\\n' "$*" >>"$R4_TEST_LOG"\n[[ $1 != is-active ]] || { echo inactive; exit 3; }\n`);
  writeExecutable(path.join(root, 'usr/bin/caddy'), `#!/usr/bin/env bash\nprintf 'CADDY-ABS %s\\n' "$*" >>"$R4_TEST_LOG"\n`);
  let shell = fs.readFileSync(path.join(bundle, 'run-luna-routing-r4.sh'), 'utf8');
  for (const prefix of ['/var/', '/etc/', '/root/', '/opt/', '/run/', '/usr/bin/']) shell = shell.split(prefix).join(`${root}${prefix}`);
  shell = shell.replace(/NODE_SHA=[0-9a-f]+/, `NODE_SHA=${sha(deb)}`);
  shell = shell.replace("(( EUID == 0 ))||die 1 'root required';", ': # root requirement covered by production source; sandbox harness is unprivileged;');
  shell = shell.replace('== 0:600', `== ${process.getuid()}:600`);
  fs.writeFileSync(path.join(bundle, 'run-luna-routing-r4.sh'), shell, { mode: 0o755 });
  const sums = fs.readdirSync(bundle, { recursive: true }).filter(p => p !== 'SUMS.txt' && fs.statSync(path.join(bundle, p)).isFile()).sort().map(p => `${sha(path.join(bundle, p))}  ${p}`).join('\n') + '\n';
  fs.writeFileSync(path.join(bundle, 'SUMS.txt'), sums);
  return { root, bundle, deb, log };
}
function executeCase(failInstall) {
  const f = fixture();
  try {
    const archive = makeArchive(f.root, failInstall);
    const release = path.join(f.root, failInstall ? 'release-fail' : 'release-ok');
    const env = { ...process.env, PATH: `${f.root}/bin:${f.root}/usr/bin:/usr/bin:/bin`, R4_ROOT: f.root, R4_HOST_NODE: hostNode, R4_TEST_LOG: f.log, TX: path.join(f.root, 'tx'), SOURCE_ARCHIVE: archive, SOURCE_SHA256: sha(archive), SOURCE_COMMIT: 'fixture-commit', DEB: f.deb, RELEASE: release };
    const out = run('bash', [path.join(f.bundle, 'run-luna-routing-r4.sh'), '--execute'], { env, cwd: f.bundle });
    return { ...f, release, out, operations: fs.readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean) };
  } catch (e) { fs.rmSync(f.root, { recursive: true, force: true }); throw e; }
}

const full = executeCase(false);
try {
  assert.equal(full.out.status, 0, full.out.stderr);
  assert.match(full.out.stdout, /HOLD — France TEST controller installed inactive/);
  const installAt = full.operations.indexOf('APT install -y ' + full.deb);
  const firstNodeDependent = full.operations.findIndex(x => x.startsWith('DOCKER '));
  assert(installAt >= 0 && firstNodeDependent > installAt, `operations: ${full.operations.join(' | ')}`);
  assert(!full.operations.some(x => x.startsWith('APT purge')), 'successful full run must retain transaction-installed Node');
  console.log(`TRACE absent-Node full: ${full.operations.join(' -> ')}`);
  console.log('PASS absent-Node full run installs pinned Node before Node-dependent inventory');
} finally { fs.rmSync(full.root, { recursive: true, force: true }); }

const rollback = executeCase(true);
try {
  assert.equal(rollback.out.status, 42, rollback.out.stderr);
  assert.match(rollback.out.stderr, /ROLLBACK — failed phase=install; full pre-job baseline restored and verified/);
  const baselineAt = rollback.operations.map((x, i) => [x, i]).filter(([x]) => x.startsWith('DOCKER inspect')).at(-1)[1];
  const purgeAt = rollback.operations.indexOf('APT purge -y nodejs');
  assert(purgeAt > baselineAt, `baseline must precede purge: ${rollback.operations.join(' | ')}`);
  assert.deepEqual(rollback.operations.filter(x => x.startsWith('APT purge')), ['APT purge -y nodejs']);
  assert.equal(fs.existsSync(path.join(rollback.root, 'usr/bin/node')), false, 'transaction-installed Node must be purged');
  assert.equal(fs.existsSync(rollback.release), false, 'transaction release must be removed');
  console.log(`TRACE absent-Node rollback: ${rollback.operations.join(' -> ')}`);
  console.log('PASS absent-Node rollback verifies baseline before purging only nodejs');
} finally { fs.rmSync(rollback.root, { recursive: true, force: true }); }
