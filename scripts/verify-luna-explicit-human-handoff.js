#!/usr/bin/env node
'use strict';

/**
 * verify-luna-explicit-human-handoff
 *
 * Offline gates for explicit human-request → flag_needs_human (human_requested).
 * Run: node scripts/verify-luna-explicit-human-handoff.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SPEC = path.join(ROOT, 'docs/LUNA-GUEST-BEHAVIOR-SPEC.md');
const SOUL_WH = path.join(ROOT, 'docker/hermes-staging/SOUL.md');
const SOUL_SU = path.join(ROOT, 'docker/hermes-sunset/SOUL.md');
const PLUGIN = path.join(ROOT, 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py');
const PY_MOD = path.join(ROOT, 'docker/hermes-staging/wolfhouse/explicit_human_handoff.py');
const PY_TEST = path.join(ROOT, 'docker/hermes-staging/wolfhouse/test_explicit_human_handoff.py');
const POLICY = path.join(ROOT, 'scripts/lib/luna-guest-handoff-policy.js');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    fail += 1;
  }
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

console.log('\nverify-luna-explicit-human-handoff — explicit human request gates\n');

console.log('[1] Spec + SOUL owner text');
const spec = read(SPEC);
assert(
  'spec lists human requested as explicit handoff reason',
  /human requested/i.test(spec) && /EXPLICIT_HANDOFF_REASONS|human_requested/.test(spec),
);
assert(
  'spec names Hermes SOUL as human_requested owner for WhatsApp path',
  /human_requested[\s\S]{0,200}SOUL\.md|explicit human request[\s\S]{0,300}SOUL/i.test(spec)
    || /Hermes[\s\S]{0,120}human_requested[\s\S]{0,120}SOUL/i.test(spec)
    || /8\.\d[\s\S]{0,80}human_requested[\s\S]{0,200}hermes-staging\/SOUL/i.test(spec),
);

const soulWh = read(SOUL_WH);
const soulSu = read(SOUL_SU);
assert(
  'Wolfhouse SOUL requires flag_needs_human for explicit human request',
  /explicitly asks to speak with a human|human_requested/i.test(soulWh)
    && /flag_needs_human/i.test(soulWh),
);
assert(
  'Wolfhouse SOUL says reason human_requested',
  /reason\s*[`']?human_requested[`']?/i.test(soulWh),
);
assert(
  'Wolfhouse SOUL forbids continuing booking intake after human request',
  /Do not continue booking intake|ask no (additional )?question/i.test(soulWh),
);
assert(
  'Sunset SOUL requires flag_needs_human for explicit human request',
  /explicitly asks to speak with a human|human_requested/i.test(soulSu)
    && /flag_needs_human/i.test(soulSu),
);

const plugin = read(PLUGIN);
assert(
  'flag_needs_human tool description mentions human request / human_requested',
  /flag_needs_human[\s\S]{0,500}human_requested|speak with a human|real person/i.test(plugin),
);

console.log('\n[2] Deterministic explicit-human module (Hermes)');
assert('explicit_human_handoff.py exists', fs.existsSync(PY_MOD));
assert('test_explicit_human_handoff.py exists', fs.existsSync(PY_TEST));

if (fs.existsSync(PY_MOD)) {
  const py = read(PY_MOD);
  assert('module exports is_explicit_human_request', /def is_explicit_human_request\b/.test(py));
  assert('module uses reason human_requested', /human_requested/.test(py));
  assert('module calls flag_needs_human path', /flag_needs_human/.test(py));
}

console.log('\n[3] Python detector unit tests');
if (fs.existsSync(PY_TEST)) {
  try {
    const out = execFileSync('python3', [PY_TEST], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    process.stdout.write(out.split('\n').map((l) => (l ? `       ${l}` : l)).join('\n'));
    if (!out.endsWith('\n')) process.stdout.write('\n');
    assert('python explicit-human tests green', /\b0 failed\b/.test(out) && !/\bFAIL\s{2}/.test(out));
  } catch (err) {
    const detail = ((err && err.stdout) || (err && err.message) || '').toString().slice(0, 800);
    assert('python explicit-human tests green', false, detail);
  }
} else {
  assert('python explicit-human tests green', false, 'missing test file');
}

console.log('\n[4] Legacy policy detector tightened (no bare human/staff false positives)');
const policy = read(POLICY);
assert('policy still lists human_requested', /human_requested/.test(policy));
assert(
  'policy exposes isExplicitHumanRequest or refined detector',
  /isExplicitHumanRequest|isExplicitHumanEscalationMessage/.test(policy),
);

try {
  const {
    isExplicitHumanEscalationMessage,
    isExplicitHumanRequest,
  } = require('./lib/luna-guest-handoff-policy');
  const detect = typeof isExplicitHumanRequest === 'function'
    ? isExplicitHumanRequest
    : isExplicitHumanEscalationMessage;

  const positives = [
    'I want to speak to a human',
    'Can I talk to a real person?',
    'Please get someone from the team',
    'Quiero hablar con una persona',
    '¿Puedo hablar con alguien del equipo?',
    'Vorrei parlare con una persona',
    'Posso parlare con qualcuno dello staff?',
    'Can a manager contact me?',
    'Stop the bot, I need staff',
  ];
  const negatives = [
    'Are there staff at reception?',
    'What time is reception open?',
    'Is someone there for check-in?',
    'Can staff arrange a taxi?',
    'My friend is a staff member',
    'human-sized surfboard',
    'Looking for 2 beds 15-20 August',
  ];
  for (const msg of positives) {
    assert(`positive: ${msg.slice(0, 40)}`, detect(msg) === true);
  }
  for (const msg of negatives) {
    assert(`negative: ${msg.slice(0, 40)}`, detect(msg) === false);
  }
} catch (err) {
  assert('policy detector loadable', false, err.message);
}

console.log(`\nverify-luna-explicit-human-handoff: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
