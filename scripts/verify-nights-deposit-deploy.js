'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const file = path.join(__dirname, 'france-wolfhouse-staging-fast-deploy.js');
const source = fs.readFileSync(file, 'utf8');
const from = 'a'.repeat(40), to = 'b'.repeat(40);
function exercise(failMigration) {
  const calls = [];
  const disk = { existsSync: p => !p.includes('/rollback/'), mkdirSync() {}, copyFileSync() {},
    mkdtempSync: () => '/tmp/fast-deploy-fake',
    rmSync() {},
    readFileSync: () => `image: luna-local/wh-staff-api:${from}`,
    writeFileSync: p => calls.push(p.endsWith('compose.yml') ? 'compose-pin' : 'receipt') };
  const realRequire = createRequire(file);
  const gate = realRequire('./lib/deploy-required-migrations-gate');
  const required = gate.requiredRelationsByMigration(path.join(__dirname, '..'));
  const child = { spawnSync(bin, args, opts) {
    const line = [bin, ...args].join(' '); calls.push(line);
    if (line.includes('node -')) {
      assert.equal(opts.stdio[0], 'pipe', 'stdin must carry the migration program');
      assert.match(opts.input, /134_wolfhouse_nights_deposit/);
      assert.match(opts.input, /wolfhouse_staging/);
      return { status: failMigration ? 1 : 0, stdout: 'MIGRATION134_PASS {}', stderr: '' };
    }
    if (line.includes('com.docker.compose.project.config_files')) return { status: 0, stdout: '/srv/staff/compose/compose.yml' };
    if (bin === 'curl') return { status: 0, stdout: '200' };
    if (line.includes('pg_class')) {
      const names = new Set(['clients']);
      for (const rels of Object.values(required)) {
        for (const rel of rels) names.add(rel === 'hostels' ? 'clients' : rel);
      }
      return { status: 0, stdout: [...names].join('\n') };
    }
    if (line.includes('schema_migration_ledger') || line.includes('operator_surfweek')) {
      return { status: 0, stdout: '' };
    }
    return { status: 0, stdout: line.includes('docker inspect') ? to : '' };
  } };
  const context = { require: name => name === 'fs' ? disk : name === 'child_process' ? child : realRequire(name),
    module: {}, console: { log() {}, error() {} }, process: { exit: () => { throw new Error('deploy stopped'); } } };
  vm.runInNewContext(source, context, { filename: file });
  const run = () => context.applyDeploy({ repo: path.join(__dirname, '..'), fromSha: from, toSha: to,
    plan: { staff: true, luna: false }, skipTests: false, staffCompose: '/srv/staff/compose/compose.yml',
    lunaCompose: '/srv/luna/wolfhouse/config/compose.yml', started: Date.now(), minutes: 5 });
  if (failMigration) assert.throws(run, /deploy stopped/); else run();
  const migrate = calls.findIndex(c => c.includes('node -'));
  assert(migrate >= 0, 'deploy must apply and read back migration 134');
  if (failMigration) {
    assert(!calls.includes('compose-pin'));
    assert(!calls.some(c => c.includes(' up ')));
  } else {
    assert(migrate < calls.indexOf('compose-pin'), 'migration precedes pin and service swap');
    assert(calls.some(c => c.includes(' up ')));
  }
}
exercise(false);
exercise(true);
console.log('PASS actual deploy orchestration: migration/readback before pin/swap; migration failure prevents swap (all process/filesystem effects intercepted)');
