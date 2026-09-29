'use strict';

// Offline name-continuity contract + registered-tool/ordinary-turn regressions.
// Prompt checks prove instructions, not an uncalled model's choice of words.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const wolf = fs.readFileSync(path.join(root, 'docker/hermes-staging/SOUL.md'), 'utf8');
const sunset = fs.readFileSync(path.join(root, 'docker/hermes-sunset/SOUL.md'), 'utf8');

assert.match(wolf, /On every quote and re-quote, carry `guest_name` and the ordered `guests` roster/,
  'Wolfhouse quote instructions must preserve the ordered roster, not just create');
assert.match(wolf, /Explicit name corrections replace the earlier value/,
  'Corrections must supersede old names');
assert.match(wolf, /Never use remembered names as booking consent/,
  'Name memory cannot authorize a write');
assert.match(wolf, /Contact-only corrections must not change the occupant roster; roster-only corrections must not change the booking contact/,
  'Independent identity fields must survive corrections to the other field');
assert.match(wolf, /An explicitly empty contact stays empty/,
  'Empty contact is an explicit value, not permission to substitute an occupant');
assert.match(wolf, /A count change retains known names for clarification, not automatic reuse of an incompatible roster/,
  'Remembering identity must be separate from safe booking auto-fill');
assert.match(sunset, /If the booking name is already known, skip the name question/,
  'Sunset must not unconditionally ask for a volunteered booking name after quote');
assert.match(sunset, /A volunteered name before the quote is still known/,
  'Quote-before-name solicitation must not discard an unsolicited name');
assert.match(sunset, /Never use remembered names as booking consent/,
  'Sunset retained names cannot manufacture consent');
for (const [tenant, soul] of [['Wolfhouse', wolf], ['Sunset', sunset]]) {
  assert.match(soul, /`capture_booking_names`/, tenant + ' must capture name-only turns without quoting or booking');
  assert.match(soul, /not booking consent/, tenant + ' capture is identity only');
}
console.log('PASS tenant name-continuity instruction contracts (not live inference)');

const requireRuntime = process.argv.includes('--require-runtime');
const contractOnly = process.argv.includes('--contract-only');
assert.ok(!(requireRuntime && contractOnly), '--require-runtime cannot be combined with --contract-only');

function runTests(label, args) {
  const result = spawnSync(process.env.PYTHON || 'python3', args, {
    cwd: root,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: [path.join(root, 'docker/hermes-staging'), process.env.PYTHONPATH]
        .filter(Boolean).join(path.delimiter),
    },
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(result.error.message);
  assert.equal(result.status, 0, label);
  const output = (result.stdout || '') + (result.stderr || '');
  assert.match(output, /Ran [1-9][0-9]* tests? in /, label + ' must execute tests');
  const skipped = /skipped[= ]/.test(output);
  if (requireRuntime) {
    assert.equal(skipped, false,
      label + ': --require-runtime forbids skips; set PYTHON and PYTHONPATH for the pinned Hermes runtime');
  } else if (skipped) {
    console.log('PORTABLE COVERAGE ONLY: ordinary Hermes tests skipped; not full persistence acceptance');
  }
}

if (!contractOnly) {
  runTests('registered name-persistence regressions', [
    'docker/hermes-staging/plugins/wolfhouse_staff_api/test_persist_guest_names.py',
  ]);
  if (requireRuntime) {
    runTests('session identity lifecycle regressions', [
      '-m', 'unittest', '-v', 'wolfhouse.test_booking_names_persistence',
    ]);
  }
}
