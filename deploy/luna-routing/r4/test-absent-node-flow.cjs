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
  writeExecutable(path.join(source, 'deploy/luna-routing/install-luna-routing.sh'), `#!/usr/bin/env bash\nprintf 'INSTALLER %s\\n' "$1" >>"$R4_TEST_LOG"\n${failInstall ? '[[ $1 != --install ]] || exit 42' : 'if [[ $1 == --install ]];then : >"$R4_ROOT/controller.active"; : >"$R4_ROOT/controller.enabled";fi'}\n`);
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
  mock('curl', `printf 'CURL %s\\n' "$*" >>"$R4_TEST_LOG"
out=; write=; url=; while (($#));do case "$1" in -o) out=$2;shift 2;; -w) write=$2;shift 2;; http*) url=$1;shift;; *) shift;;esac;done
if [[ $url == http://127.0.0.1:2019/config/ ]];then if [[ \${R4_FAULT_ROUTE:-0} == 1 && $out == *active.after.json ]];then cp "$R4_ROOT/bundle/fixtures/pathless-webhook-delivery.json" "$out";else cp "$R4_ROOT/var/lib/caddy/.config/caddy/autosave.json" "$out";fi;exit 0;fi
if [[ $write == '%{http_code}' ]];then [[ \${R4_FAULT_CURL:-0} != 1 ]]||exit 7;printf '{"ok":false,"code":"unauthorized"}\\n' >"$out";printf 401;exit 0;fi
if [[ -n $write ]];then printf '%s\\t200\\t0\\t\\n' "$url";exit 0;fi
exit 0`);
  mock('docker', `printf 'DOCKER %s\\n' "$*" >>"$R4_TEST_LOG"\nif [[ $1 == ps ]]; then echo crowsnest-fixture; elif [[ $* == *Config.Env* ]];then exit 0; else echo 'container-fixture luna-local/crowsnest:998f962abcfaf09e7aa7435592d94eb34af27c97 true'; fi`);
  mock('caddy', `printf 'CADDY %s\\n' "$*" >>"$R4_TEST_LOG"`);
  mock('apt-get', `printf 'APT %s\\n' "$*" >>"$R4_TEST_LOG"
if [[ $1 == -s ]]; then printf 'Inst nodejs (22.23.3-1nodesource1 local-deb [amd64])\\nConf nodejs (22.23.3-1nodesource1 local-deb [amd64])\\n'; [[ \${R4_APT_SIM_FAIL:-0} != 1 ]]||exit 100; exit 0; fi
if [[ $1 == install ]]; then
  cat >"$R4_ROOT/usr/bin/node" <<'NODE'
#!/usr/bin/env bash
if [[ \${1:-} == --version ]]; then echo v22.23.3; elif [[ \${R4_INVENTORY_FAIL:-0} == 1 && \${1:-} == */caddy-import-inventory.cjs && \${4:-} == *prewrite.identity.json ]];then exit 57; elif [[ \${1:-} == */probe-luna-routing-get.cjs ]];then printf '{"status":503,"body":{"ok":false,"code":"route_readback_failed"}}\\n'; else exec "\${R4_HOST_NODE:?}" "$@"; fi
NODE
  chmod 755 "$R4_ROOT/usr/bin/node"; [[ \${R4_APT_PARTIAL_FAIL:-0} != 1 ]]||exit 42; exit 0
fi
if [[ $1 == purge ]]; then [[ $* == 'purge -y nodejs' ]] || exit 91; rm -f "$R4_ROOT/usr/bin/node"; exit 0; fi
[[ $1 == update ]]`);
  writeExecutable(path.join(root, 'usr/bin/systemctl'), `#!/usr/bin/env bash\nprintf 'SYSTEMCTL %s\\n' "$*" >>"$R4_TEST_LOG"\ncase "$1" in is-active) [[ -e "$R4_ROOT/controller.active" ]]&&exit 0; echo inactive;exit 3;; is-enabled) [[ -e "$R4_ROOT/controller.enabled" ]];; stop) [[ \${R4_FAULT_STOP:-0} != 1 ]]||exit 55;rm -f "$R4_ROOT/controller.active";; start) : >"$R4_ROOT/controller.active";; enable) : >"$R4_ROOT/controller.enabled";; disable) rm -f "$R4_ROOT/controller.enabled";; esac\n`);
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
function executeCase(input = {}) {
  const options = typeof input === 'boolean' ? { failInstall: input } : input;
  const f = fixture();
  try {
    const archive = makeArchive(f.root, Boolean(options.failInstall));
    const release = path.join(f.root, options.failInstall ? 'release-fail' : 'release-ok');
    if (options.priorActive) { fs.writeFileSync(path.join(f.root, 'controller.active'), ''); fs.writeFileSync(path.join(f.root, 'controller.enabled'), ''); }
    const env = { ...process.env, PATH: `${f.root}/bin:${f.root}/usr/bin:/usr/bin:/bin`, R4_ROOT: f.root, R4_HOST_NODE: hostNode, R4_TEST_LOG: f.log, TX: path.join(f.root, 'tx'), SOURCE_ARCHIVE: archive, SOURCE_SHA256: sha(archive), SOURCE_COMMIT: 'fixture-commit', DEB: f.deb, RELEASE: release,
      R4_FAULT_ROUTE: options.faultRoute ? '1' : '0', R4_FAULT_CURL: options.faultCurl ? '1' : '0', R4_APT_SIM_FAIL: options.aptSimFail ? '1' : '0', R4_APT_PARTIAL_FAIL: options.aptPartialFail ? '1' : '0', R4_INVENTORY_FAIL: options.inventoryFail ? '1' : '0', R4_FAULT_STOP: options.faultStop ? '1' : '0' };
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

for (const [name, options, expected] of [
  ['failed apt simulation', { aptSimFail: true }, 100],
  ['forbidden active route graph', { faultRoute: true }, 1],
  ['unauthenticated curl refusal', { faultCurl: true }, 1],
  ['inventory failure after Node install', { inventoryFail: true }, 57],
  ['partial package install failure', { aptPartialFail: true }, 42],
]) {
  const result = executeCase(options);
  try {
    assert.equal(result.out.status, expected, `${name}: ${result.out.stderr}`);
    assert.doesNotMatch(result.out.stdout, /HOLD — France TEST controller installed inactive/);
    if (options.inventoryFail || options.aptPartialFail) {
      assert.equal(fs.existsSync(path.join(result.root, 'usr/bin/node')), false, `${name}: partial Node must be purged`);
      assert.match(result.out.stderr, /ROLLBACK —/);
    }
    if (options.aptSimFail) assert.equal(result.operations.some(x => x.startsWith('APT install ')), false);
    console.log(`PASS ${name} fails closed with rollback discipline`);
  } finally { fs.rmSync(result.root, { recursive: true, force: true }); }
}

const priorActive = executeCase({ failInstall: true, priorActive: true });
try {
  assert.equal(priorActive.out.status, 42, priorActive.out.stderr);
  assert.equal(fs.existsSync(path.join(priorActive.root, 'controller.active')), true, 'prior active controller must be restarted');
  assert.equal(fs.existsSync(path.join(priorActive.root, 'controller.enabled')), true, 'prior enabled controller must be restored');
  assert(priorActive.operations.some(x => x === 'SYSTEMCTL start luna-routing-controller.service'));
  console.log('PASS prior active/enabled controller state is restored');
} finally { fs.rmSync(priorActive.root, { recursive: true, force: true }); }

const stopFailure = executeCase({ failInstall: true, faultStop: true });
try {
  assert.equal(stopFailure.out.status, 2, stopFailure.out.stderr);
  assert.equal(fs.existsSync(stopFailure.release), true, 'release must be retained after unconfirmed stop');
  assert.equal(fs.existsSync(path.join(stopFailure.root, 'usr/bin/node')), true, 'runtime must be retained after unconfirmed stop');
  assert.match(stopFailure.out.stderr, /ROLLBACK INCOMPLETE/);
  assert.match(stopFailure.out.stderr, /backup=/);
  console.log('PASS stop failure retains release/runtime and emits bounded recovery evidence');
} finally { fs.rmSync(stopFailure.root, { recursive: true, force: true }); }
