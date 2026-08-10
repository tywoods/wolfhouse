'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SOURCE_PATH = require.resolve('./lib/email-luna-draft-policy');
const HANDOFF_PATH = require.resolve('./lib/email-luna-draft-handoff-contract');
const SOURCE_SHA256 = 'dc39247e5f75f5bae7b6188dc37445fb83a840fa321f1c3e2c4164401a7beaf8';
const CONSTRUCTOR_VALIDATION_BLOCK = [
  '  objectFreeze(copy);',
  '  frozenResult(copy, fact);',
  '  return copy;',
].join('\n');
const CONSTRUCTOR_WITHOUT_RESULT_VALIDATION = [
  '  objectFreeze(copy);',
  '  return copy;',
].join('\n');
const POLICY_VALIDATION_BLOCK = '  const results = frozenResults(evidence.grounded_results, requiredFacts);';
const POLICY_WITHOUT_RESULT_VALIDATION = '  const results = evidence.grounded_results;';

const IDS = Object.freeze({
  client_id: '11111111-1111-4111-8111-111111111111',
  location_id: '22222222-2222-4222-8222-222222222222',
  conversation_id: '33333333-3333-4333-8333-333333333333',
  endpoint_id: '44444444-4444-4444-8444-444444444444',
  inbound_message_id: '55555555-5555-4555-8555-555555555555',
});

function occurrences(source, block) {
  return source.split(block).length - 1;
}

function replaceUnique(source, block, replacement, label) {
  assert.equal(occurrences(source, block), 1, `${label}: pinned source block must occur exactly once`);
  const mutated = source.replace(block, replacement);
  assert.notEqual(mutated, source, `${label}: mutation must apply`);
  assert.equal(occurrences(mutated, block), 0, `${label}: original block must be absent after mutation`);
  return mutated;
}

function makeVariant(root, name, source) {
  const libDir = path.join(root, name, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  fs.copyFileSync(HANDOFF_PATH, path.join(libDir, 'email-luna-draft-handoff-contract.js'));
  const mutantPath = path.join(libDir, 'email-luna-draft-policy.js');
  fs.writeFileSync(mutantPath, source, { flag: 'wx' });
  return {
    policy: require(mutantPath),
    handoff: require(path.join(libDir, 'email-luna-draft-handoff-contract.js')),
  };
}

function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) value[key] = frozen(value[key]);
    return Object.freeze(value);
  }
  return value;
}

function envelope(createEmailLunaDraftEnvelope) {
  return createEmailLunaDraftEnvelope({
    authority: {
      ...IDS,
      location_key: 'sunset-somo',
    },
    untrusted_content: {
      subject: 'Booking question',
      body_text: 'Is my booking confirmed?',
      quoted_history: '',
      from_display_name: 'Elena',
      from_address: 'elena@example.test',
    },
  });
}

function result(patch = {}) {
  return Object.assign(Object.create(null), {
    fact: 'booking',
    status: 'found',
    client_id: IDS.client_id,
    location_id: IDS.location_id,
    booking_code: 'SUN-42',
    booking_status: 'confirmed',
    ...patch,
  });
}

function evidence(groundedResult) {
  return {
    client_id: IDS.client_id,
    location_id: IDS.location_id,
    conversation_id: IDS.conversation_id,
    language: 'en',
    identity: 'matched',
    intent: 'booking_status_question',
    intent_support: 'supported',
    requested_location_id: IDS.location_id,
    explicit_human_request: false,
    unsafe_transactional_request: false,
    required_facts: ['booking'],
    grounded_results: { booking: groundedResult },
  };
}

const UNSAFE_PROBES = Object.freeze([
  ['core-only schema', () => result({ booking_code: undefined, booking_status: undefined }), ['booking_code', 'booking_status']],
  ['wrong-type schema', () => result({ booking_status: true }), []],
  ['non-finite schema', () => result({ guest_count: NaN }), []],
  ['fact/result binding', () => result({ fact: 'payment' }), []],
]);

function materializeProbe(makeResult, omittedKeys) {
  const value = makeResult();
  for (const key of omittedKeys) delete value[key];
  return frozen(value);
}

function exerciseSafetyContract(policy, createEmailLunaDraftEnvelope) {
  const accepted = [];
  for (const [label, makeResult, omittedKeys] of UNSAFE_PROBES) {
    let unsafeAccepted = false;
    try {
      const issued = policy.createEmailLunaDraftPolicyEvidence(
        evidence(materializeProbe(makeResult, omittedKeys)),
      );
      const decision = policy.decideEmailLunaDraftPolicy({
        envelope: envelope(createEmailLunaDraftEnvelope),
        evidence: issued,
      });
      unsafeAccepted = decision.status === 'draft_ready';
    } catch (error) {
      assert.equal(error && error.code, 'EMAIL_LUNA_DRAFT_POLICY_INVALID', `${label}: must fail closed with typed error`);
    }
    if (unsafeAccepted) accepted.push(label);
  }
  return accepted;
}

const source = fs.readFileSync(SOURCE_PATH, 'utf8');
const digest = crypto.createHash('sha256').update(source).digest('hex');
assert.equal(digest, SOURCE_SHA256, 'production source changed: review and deliberately re-pin mutation anchors');
assert.equal(occurrences(source, CONSTRUCTOR_VALIDATION_BLOCK), 1, 'constructor validation anchor drifted');
assert.equal(occurrences(source, POLICY_VALIDATION_BLOCK), 1, 'policy validation anchor drifted');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-luna-policy-mutations-'));
try {
  const constructorControlSource = replaceUnique(
    source,
    POLICY_VALIDATION_BLOCK,
    POLICY_WITHOUT_RESULT_VALIDATION,
    'constructor control disables masking policy defense',
  );
  const constructorMutantSource = replaceUnique(
    constructorControlSource,
    CONSTRUCTOR_VALIDATION_BLOCK,
    CONSTRUCTOR_WITHOUT_RESULT_VALIDATION,
    'constructor target defense',
  );
  const constructorControl = makeVariant(root, 'constructor-control', constructorControlSource);
  const constructorMutant = makeVariant(root, 'constructor-mutant', constructorMutantSource);

  assert.deepEqual(
    exerciseSafetyContract(constructorControl.policy, constructorControl.handoff.createEmailLunaDraftEnvelope),
    [],
    'constructor control must reject every unsafe probe while policy revalidation is disabled',
  );
  assert.deepEqual(
    exerciseSafetyContract(constructorMutant.policy, constructorMutant.handoff.createEmailLunaDraftEnvelope),
    UNSAFE_PROBES.map(([label]) => label),
    'constructor mutant must be killed by every isolated unsafe probe',
  );
  console.log('  PASS  constructor validation independently kills schema and fact-binding mutants');

  const policyControlSource = replaceUnique(
    source,
    CONSTRUCTOR_VALIDATION_BLOCK,
    CONSTRUCTOR_WITHOUT_RESULT_VALIDATION,
    'policy control disables masking constructor defense',
  );
  const policyMutantSource = replaceUnique(
    policyControlSource,
    POLICY_VALIDATION_BLOCK,
    POLICY_WITHOUT_RESULT_VALIDATION,
    'policy target defense',
  );
  const policyControl = makeVariant(root, 'policy-control', policyControlSource);
  const policyMutant = makeVariant(root, 'policy-mutant', policyMutantSource);

  assert.deepEqual(
    exerciseSafetyContract(policyControl.policy, policyControl.handoff.createEmailLunaDraftEnvelope),
    [],
    'policy control must reject every unsafe probe while constructor validation is disabled',
  );
  assert.deepEqual(
    exerciseSafetyContract(policyMutant.policy, policyMutant.handoff.createEmailLunaDraftEnvelope),
    UNSAFE_PROBES.map(([label]) => label),
    'policy mutant must be killed by every isolated unsafe probe',
  );
  console.log('  PASS  decision-time validation independently kills schema and fact-binding mutants');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('ALL OK — Email Luna draft policy mutation isolation');
