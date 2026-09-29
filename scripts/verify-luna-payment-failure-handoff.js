#!/usr/bin/env node
'use strict';

// Offline L2 regression entrypoint. Synthetic payment transport, real wrappers;
// the separate SQL proof reads persisted Needs Human rows from isolated PGlite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

for (const relative of ['docker/hermes-staging/SOUL.md', 'docker/hermes-sunset/SOUL.md']) {
  const soul = fs.readFileSync(path.join(root, relative), 'utf8');
  assert.match(soul, /Payment failure — honest human help/);
  assert.match(soul, /handoff_confirmed/);
  assert.match(soul, /Do not recreate the booking or retry checkout automatically/);
  assert.match(soul, /cannot confirm the handoff/);
  assert.match(soul, /saved booking is not a paid booking/);
  console.log(`PASS ${relative}: payment failure and unconfirmed-handoff instructions`);
}
if (process.argv.includes('--soul-only')) process.exit(0);

for (const [command, args] of [
  ['python3', ['docker/hermes-staging/plugins/wolfhouse_staff_api/test_payment_failure_handoff.py']],
  ['python3', ['docker/hermes-staging/plugins/wolfhouse_staff_api/test_payment_failure_ordinary_handoff.py']],
  [process.execPath, ['scripts/verify-luna-payment-failure-handoff-sql.js']],
]) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, PYTHONPATH: path.join(root, 'docker/hermes-staging'), PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8', timeout: 120000,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed`);
}
console.log('PASS payment-failure handoff offline gate (no live provider/model/delivery proof)');
