'use strict';
/** FULL SAIL Stage 1 NIGHTWATCH Chapter 1 Slice B: same-composition-turn freshness. */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEmailLunaDraftEnvelope } = require('./lib/email-luna-draft-handoff-contract');
const {
  createEmailLunaDraftPolicyEvidence,
  decideEmailLunaDraftPolicy,
  issueAndDecideEmailLunaDraftPolicy,
  assertEmailLunaDraftPolicyIssuance,
  EMAIL_LUNA_DRAFT_POLICY_HANDOFF_REASONS,
} = require('./lib/email-luna-draft-policy');
const { decideEmailLunaAutonomousEligibility } = require('./lib/email-luna-autonomous-eligibility-policy');
const { createEmailLunaDraftAuthor } = require('./lib/email-luna-draft-author');
const { createEmailLunaDraftOpenPolicyComposition } = require('./lib/email-luna-draft-open-policy-composition');

const POLICY_PATH = require.resolve('./lib/email-luna-draft-policy');
const HANDOFF_PATH = require.resolve('./lib/email-luna-draft-handoff-contract');
const COMPOSITION_PATH = require.resolve('./lib/email-luna-draft-open-policy-composition');
const AUTONOMOUS_PATH = require.resolve('./lib/email-luna-autonomous-eligibility-policy');

const IDS = Object.freeze({
  client_id: '11111111-1111-4111-8111-111111111111',
  location_id: '22222222-2222-4222-8222-222222222222',
  conversation_id: '33333333-3333-4333-8333-333333333333',
  endpoint_id: '44444444-4444-4444-8444-444444444444',
  inbound_message_id: '55555555-5555-4555-8555-555555555555',
});
const FRESHNESS_STAMP_BLOCK = [
  '  weakSetAdd(AUTHENTIC_POLICY_EVIDENCE, issued);',
  '  stampIssuedEvidenceFreshness(issued);',
  '  return issued;',
].join('\n');
const FRESHNESS_STAMP_REMOVED = [
  '  weakSetAdd(AUTHENTIC_POLICY_EVIDENCE, issued);',
  '  return issued;',
].join('\n');
const FRESHNESS_CHECK_BLOCK = [
  '  const freshness = inspectIssuedEvidenceFreshness(request.evidence);',
  '  if (freshness === \'stale\') return finish(handoff(\'stale_evidence\', trusted.binding));',
  '  if (freshness !== \'fresh\') throw invalid();',
].join('\n');
const FRESHNESS_CHECK_BYPASS = '  const freshness = \'fresh\'; void inspectIssuedEvidenceFreshness;';
const SCOPE_EXIT_BLOCK = [
  '  } finally {',
  '    freshnessScopeOpen = false;',
  '    if (numberIsSafeInteger(freshnessScopeGeneration) && freshnessScopeGeneration < Number.MAX_SAFE_INTEGER) {',
  '      freshnessScopeGeneration += 1;',
  '    }',
  '  }',
].join('\n');
const SCOPE_EXIT_REMOVED = '  } finally {\n  }';
const COMPOSITION_ISSUE_DECIDE = [
  '      const issued = issueAndDecideEmailLunaDraftPolicy({',
  '        envelope,',
  '        evidence: {',
  '          client_id: classified.client_id,',
  '          location_id: classified.location_id,',
  '          conversation_id: classified.conversation_id,',
  '          endpoint_id: classified.endpoint_id,',
  '          language: classified.language,',
  '          identity: classified.identity,',
  '          intent: classified.intent,',
  '          intent_support: classified.intent_support,',
  '          requested_location_id: classified.requested_location_id,',
  '          explicit_human_request: classified.explicit_human_request,',
  '          attachment_interpretation_required: classified.attachment_interpretation_required,',
  '          unsafe_transactional_request: classified.unsafe_transactional_request,',
  '          required_facts: classified.required_facts,',
  '          grounded_results: groundedResults,',
  '        },',
  '      });',
  '      evidence = issued.evidence;',
  '      decision = issued.decision;',
].join('\n');

function frozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const nested = frozen(value[key]);
      if (!Object.isFrozen(value)) value[key] = nested;
    }
    return Object.freeze(value);
  }
  return value;
}

function authority(patch = {}) {
  return { ...IDS, location_key: 'sunset-somo', ...patch };
}
function content(patch = {}) {
  return {
    subject: 'Question about board rental',
    body_text: 'How much is board rental this weekend?',
    quoted_history: '<blockquote>Previous guest email only.</blockquote>',
    from_display_name: 'Elena',
    from_address: 'elena@example.test',
    ...patch,
  };
}
function envelope(contentPatch = {}, authorityPatch = {}) {
  return createEmailLunaDraftEnvelope({
    authority: authority(authorityPatch),
    untrusted_content: content(contentPatch),
  });
}
function found(fact, extra = {}) {
  return frozen(Object.assign(Object.create(null), {
    fact,
    status: 'found',
    client_id: IDS.client_id,
    location_id: IDS.location_id,
    item: 'board_rental',
    label: 'Board rental',
    currency: 'EUR',
    amount_cents: 2000,
    active: true,
    ...extra,
  }));
}
function evidence(patch = {}) {
  const value = {
    client_id: IDS.client_id,
    location_id: IDS.location_id,
    conversation_id: IDS.conversation_id,
    endpoint_id: IDS.endpoint_id,
    language: 'en',
    identity: 'matched',
    intent: 'catalog_question',
    intent_support: 'supported',
    requested_location_id: IDS.location_id,
    explicit_human_request: false,
    attachment_interpretation_required: false,
    unsafe_transactional_request: false,
    required_facts: ['catalog'],
    grounded_results: frozen({ catalog: found('catalog') }),
    ...patch,
  };
  return frozen(value);
}
function canonicalIssue(producerPatch = {}, envelopePatch = {}) {
  const env = envelope(envelopePatch);
  const issued = issueAndDecideEmailLunaDraftPolicy({
    envelope: env,
    evidence: evidence(producerPatch),
  });
  return { envelope: env, evidence: issued.evidence, decision: issued.decision };
}
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
function assertHandoff(result, reason) {
  assert.deepEqual(Object.keys(result), [
    'status', 'reason', 'client_id', 'location_id', 'conversation_id',
    'draft_only', 'requires_staff_review', 'send_allowed', 'auto_send_allowed',
  ]);
  assert.deepEqual(plain(result), {
    status: 'handoff_required', reason,
    client_id: IDS.client_id, location_id: IDS.location_id, conversation_id: IDS.conversation_id,
    draft_only: true, requires_staff_review: true, send_allowed: false, auto_send_allowed: false,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.getPrototypeOf(result), null);
}
function expectInvalid(fn, label) {
  assert.throws(fn, (error) => {
    assert.equal(error && error.code, 'EMAIL_LUNA_DRAFT_POLICY_INVALID', label);
    assert.equal(error && error.message, 'Email Luna draft policy failed.', label);
    return true;
  });
}
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
function loadPolicyVariant(name, mutatedSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `email-luna-freshness-${name}-`));
  const libDir = path.join(root, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  fs.copyFileSync(HANDOFF_PATH, path.join(libDir, 'email-luna-draft-handoff-contract.js'));
  const mutantPath = path.join(libDir, 'email-luna-draft-policy.js');
  fs.writeFileSync(mutantPath, mutatedSource, { flag: 'wx' });
  return {
    root,
    policy: require(mutantPath),
    handoff: require(path.join(libDir, 'email-luna-draft-handoff-contract.js')),
  };
}
function schedulerChildFixture() {
  return [
    "'use strict';",
    'const { createEmailLunaDraftEnvelope } = require(' + JSON.stringify(HANDOFF_PATH) + ');',
    'const policy = require(' + JSON.stringify(POLICY_PATH) + ');',
    'const IDS = Object.freeze({',
    "  client_id: '11111111-1111-4111-8111-111111111111',",
    "  location_id: '22222222-2222-4222-8222-222222222222',",
    "  conversation_id: '33333333-3333-4333-8333-333333333333',",
    "  endpoint_id: '44444444-4444-4444-8444-444444444444',",
    "  inbound_message_id: '55555555-5555-4555-8555-555555555555',",
    '});',
    'function found() {',
    '  return Object.freeze(Object.assign(Object.create(null), {',
    "    fact: 'catalog', status: 'found', client_id: IDS.client_id, location_id: IDS.location_id,",
    "    item: 'board_rental', label: 'Board rental', currency: 'EUR', amount_cents: 2000, active: true,",
    '  }));',
    '}',
    'function producer() {',
    '  return Object.freeze({',
    '    client_id: IDS.client_id, location_id: IDS.location_id, conversation_id: IDS.conversation_id,',
    '    endpoint_id: IDS.endpoint_id, language: \'en\', identity: \'matched\', intent: \'catalog_question\',',
    '    intent_support: \'supported\', requested_location_id: IDS.location_id, explicit_human_request: false,',
    '    attachment_interpretation_required: false, unsafe_transactional_request: false,',
    "    required_facts: Object.freeze(['catalog']),",
    '    grounded_results: Object.freeze({ catalog: found() }),',
    '  });',
    '}',
    'function envelope() {',
    '  return createEmailLunaDraftEnvelope({',
    "    authority: { ...IDS, location_key: 'sunset-somo' },",
    '    untrusted_content: {',
    "      subject: 'Question about board rental', body_text: 'How much is board rental this weekend?',",
    "      quoted_history: '<blockquote>Previous guest email only.</blockquote>',",
    "      from_display_name: 'Elena', from_address: 'elena@example.test',",
    '    },',
    '  });',
    '}',
  ].join('\n');
}
function spawnSchedulerProbe(preloadSource, bodySource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-luna-freshness-sched-'));
  try {
    const preloadPath = path.join(root, 'preload.js');
    fs.writeFileSync(preloadPath, preloadSource, { flag: 'wx' });
    const env = { ...process.env, NO_COLOR: '1' };
    delete env.FORCE_COLOR;
    return spawnSync(process.execPath, ['--require', preloadPath, '-e', bodySource], {
      encoding: 'utf8',
      timeout: 10000,
      env,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function parseSchedulerProbe(result, label) {
  assert.equal(result.status, 0, `${label}: child must exit 0\n${result.stderr}\n${result.stdout}`);
  assert.equal(result.error, undefined, `${label}: child must spawn`);
  return JSON.parse(result.stdout);
}

(async () => {
  console.log('FULL SAIL Stage 1 NIGHTWATCH Ch1 Slice B same-composition-turn freshness verifier');

  const env = envelope();
  const issued = issueAndDecideEmailLunaDraftPolicy({ envelope: env, evidence: evidence() });
  const sameTurn = issued.decision;
  assert.equal(sameTurn.status, 'draft_ready');
  assert.equal(sameTurn.send_allowed, false);
  assert.equal(sameTurn.auto_send_allowed, false);
  assertEmailLunaDraftPolicyIssuance({ envelope: env, evidence: issued.evidence, decision: sameTurn });
  console.log('  PASS  same-composition-turn issuance still decides draft_ready');

  const laterTurn = decideEmailLunaDraftPolicy({ envelope: env, evidence: issued.evidence });
  assert.notEqual(laterTurn.status, 'draft_ready', 'retained evidence must not remain draft_ready after its issuance turn');
  assertHandoff(laterTurn, 'stale_evidence');
  console.log('  PASS  canonical evidence retained beyond its issuance turn fail-closes to stale_evidence');

  const standalone = createEmailLunaDraftPolicyEvidence(evidence());
  assertHandoff(
    decideEmailLunaDraftPolicy({ envelope: envelope(), evidence: standalone }),
    'stale_evidence',
  );
  console.log('  PASS  standalone retained evidence passed later to decide is stale/unissued');

  const noOpProbe = parseSchedulerProbe(spawnSchedulerProbe(
    "'use strict'; globalThis.queueMicrotask = function noOpQueueMicrotask() {};",
    [
      schedulerChildFixture(),
      '(async () => {',
      '  const env = envelope();',
      '  const issued = policy.issueAndDecideEmailLunaDraftPolicy({ envelope: env, evidence: producer() });',
      '  await Promise.resolve();',
      '  await Promise.resolve();',
      '  const later = policy.decideEmailLunaDraftPolicy({ envelope: env, evidence: issued.evidence });',
      '  const again = policy.issueAndDecideEmailLunaDraftPolicy({ envelope: env, evidence: producer() });',
      '  process.stdout.write(JSON.stringify({',
      '    first: issued.decision.status, later: later.status, laterReason: later.reason || null,',
      '    again: again.decision.status,',
      '  }));',
      '})().catch((error) => { console.error(error && error.stack || error); process.exit(1); });',
    ].join('\n'),
  ), 'preload no-op queueMicrotask');
  assert.equal(noOpProbe.first, 'draft_ready', 'canonical issue+decide must work under preload no-op queueMicrotask');
  assert.notEqual(noOpProbe.later, 'draft_ready', 'preload no-op queueMicrotask must not keep retained evidence draft_ready');
  assert.equal(noOpProbe.later, 'handoff_required');
  assert.equal(noOpProbe.laterReason, 'stale_evidence');
  assert.equal(noOpProbe.again, 'draft_ready');
  console.log('  PASS  preload no-op queueMicrotask cannot keep retained evidence fresh');

  const throwOnceProbe = parseSchedulerProbe(spawnSchedulerProbe(
    [
      "'use strict';",
      'const originalQueueMicrotask = queueMicrotask;',
      'let throwsLeft = 1;',
      'globalThis.queueMicrotask = function throwOnceQueueMicrotask(fn) {',
      '  if (throwsLeft > 0) { throwsLeft -= 1; throw new Error(\'queueMicrotask throw-once\'); }',
      '  return originalQueueMicrotask(fn);',
      '};',
    ].join('\n'),
    [
      schedulerChildFixture(),
      '(async () => {',
      '  let firstCreateThrew = false;',
      '  try { policy.createEmailLunaDraftPolicyEvidence(producer()); }',
      '  catch (error) { firstCreateThrew = error && error.message === \'queueMicrotask throw-once\'; }',
      '  const env = envelope();',
      '  const issued = policy.issueAndDecideEmailLunaDraftPolicy({ envelope: env, evidence: producer() });',
      '  await Promise.resolve();',
      '  await Promise.resolve();',
      '  const later = policy.decideEmailLunaDraftPolicy({ envelope: env, evidence: issued.evidence });',
      '  const nextStandalone = policy.createEmailLunaDraftPolicyEvidence(producer());',
      '  const nextLater = policy.decideEmailLunaDraftPolicy({ envelope: env, evidence: nextStandalone });',
      '  const nextCanonical = policy.issueAndDecideEmailLunaDraftPolicy({ envelope: env, evidence: producer() });',
      '  process.stdout.write(JSON.stringify({',
      '    firstCreateThrew, first: issued.decision.status, later: later.status, laterReason: later.reason || null,',
      '    nextLater: nextLater.status, nextLaterReason: nextLater.reason || null,',
      '    nextCanonical: nextCanonical.decision.status,',
      '  }));',
      '})().catch((error) => { console.error(error && error.stack || error); process.exit(1); });',
    ].join('\n'),
  ), 'throw-once queueMicrotask');
  assert.equal(throwOnceProbe.firstCreateThrew, false, 'issue/create must not depend on queueMicrotask');
  assert.equal(throwOnceProbe.first, 'draft_ready');
  assert.notEqual(throwOnceProbe.later, 'draft_ready', 'throw-once queueMicrotask must not latch retained evidence fresh');
  assert.equal(throwOnceProbe.later, 'handoff_required');
  assert.equal(throwOnceProbe.laterReason, 'stale_evidence');
  assert.notEqual(throwOnceProbe.nextLater, 'draft_ready', 'throw-once queueMicrotask must not leave later evidence fresh');
  assert.equal(throwOnceProbe.nextCanonical, 'draft_ready');
  console.log('  PASS  throw-once queueMicrotask cannot latch scheduling off and keep later evidence fresh');

  const originalQueueMicrotask = queueMicrotask;
  try {
    globalThis.queueMicrotask = function postImportThrow() { throw new Error('post-import queueMicrotask'); };
    const liveEnv = envelope();
    const live = issueAndDecideEmailLunaDraftPolicy({ envelope: liveEnv, evidence: evidence() });
    assert.equal(live.decision.status, 'draft_ready');
    assertHandoff(decideEmailLunaDraftPolicy({ envelope: liveEnv, evidence: live.evidence }), 'stale_evidence');
  } finally {
    globalThis.queueMicrotask = originalQueueMicrotask;
  }
  console.log('  PASS  behavior is independent of monkeypatched/no-op/throwing queueMicrotask');

  const attached = canonicalIssue({ attachment_interpretation_required: true });
  assert.equal(attached.decision.status, 'draft_ready', 'fresh human drafting still authors when attachments need interpretation');
  assertHandoff(decideEmailLunaDraftPolicy({ envelope: attached.envelope, evidence: attached.evidence }), 'stale_evidence');
  console.log('  PASS  fresh human draft_ready is preserved; retained attachment evidence cannot stay draft_ready');

  const first = canonicalIssue();
  assert.equal(first.decision.status, 'draft_ready');
  assertEmailLunaDraftPolicyIssuance({ envelope: first.envelope, evidence: first.evidence, decision: first.decision });
  const authored = await createEmailLunaDraftAuthor({
    callModel: () => Promise.resolve(JSON.stringify({
      template_id: 'catalog_reply', tone: 'warm', question_key: 'none', acknowledgment_key: 'thanks',
    })),
  }).authorDraft({ envelope: first.envelope, evidence: first.evidence, decision: first.decision });
  assert.equal(authored.status, 'draft_ready');
  assert.equal(authored.send_allowed, false);
  const laterEligible = decideEmailLunaAutonomousEligibility({
    envelope: first.envelope, evidence: first.evidence, decision: first.decision,
  });
  assert.equal(laterEligible.status, 'eligible');
  assert.equal(laterEligible.send_allowed, false);
  assert.equal(laterEligible.auto_send_allowed, false);
  assertHandoff(decideEmailLunaAutonomousEligibility({
    envelope: first.envelope, evidence: first.evidence, decision: first.decision,
  }), 'stale_evidence');
  assertHandoff(decideEmailLunaDraftPolicy({ envelope: first.envelope, evidence: first.evidence }), 'stale_evidence');
  console.log('  PASS  same-turn decision remains authorable and single-use eligible after the issuance turn ends');

  const handoffIssue = canonicalIssue({ identity: 'ambiguous' });
  assertHandoff(handoffIssue.decision, 'ambiguous_identity');
  const firstProjection = decideEmailLunaAutonomousEligibility({
    envelope: handoffIssue.envelope, evidence: handoffIssue.evidence, decision: handoffIssue.decision,
  });
  assertHandoff(firstProjection, 'ambiguous_identity');
  assertHandoff(decideEmailLunaAutonomousEligibility({
    envelope: handoffIssue.envelope, evidence: handoffIssue.evidence, decision: handoffIssue.decision,
  }), 'ambiguous_identity');
  assertHandoff(decideEmailLunaAutonomousEligibility({
    envelope: handoffIssue.envelope, evidence: handoffIssue.evidence, decision: handoffIssue.decision,
  }), 'ambiguous_identity');
  assertHandoff(decideEmailLunaDraftPolicy({ envelope: handoffIssue.envelope, evidence: handoffIssue.evidence }), 'stale_evidence');
  console.log('  PASS  Ch1A typed handoff replay remains byte-stable; retained evidence cannot be re-decided ready');

  const staleEnv = envelope();
  const staleEvidence = createEmailLunaDraftPolicyEvidence(evidence());
  const staleDecision = decideEmailLunaDraftPolicy({ envelope: staleEnv, evidence: staleEvidence });
  assertHandoff(staleDecision, 'stale_evidence');
  assertEmailLunaDraftPolicyIssuance({ envelope: staleEnv, evidence: staleEvidence, decision: staleDecision });
  const staleProjection = decideEmailLunaAutonomousEligibility({
    envelope: staleEnv, evidence: staleEvidence, decision: staleDecision,
  });
  assertHandoff(staleProjection, 'stale_evidence');
  assertHandoff(decideEmailLunaAutonomousEligibility({
    envelope: staleEnv, evidence: staleEvidence, decision: staleDecision,
  }), 'stale_evidence');
  assert.equal(staleProjection.status, 'handoff_required');
  console.log('  PASS  later-turn evidence is a typed canonical handoff before draft_ready or autonomous eligible');

  for (const [label, extra] of [
    ['ttl_ms', { ttl_ms: 0 }],
    ['issued_at', { issued_at: '2026-08-23T00:00:00.000Z' }],
    ['turn', { turn: 1 }],
    ['freshness', { freshness: 'fresh' }],
    ['clock', { clock: 'system' }],
    ['expires_at', { expires_at: 1 }],
  ]) {
    expectInvalid(() => createEmailLunaDraftPolicyEvidence(evidence(extra)), `caller cannot select ${label}`);
    expectInvalid(() => issueAndDecideEmailLunaDraftPolicy({
      envelope: envelope(), evidence: evidence(extra),
    }), `canonical issue+decide cannot select ${label}`);
  }
  expectInvalid(() => createEmailLunaDraftPolicyEvidence(evidence({
    grounded_results: frozen({ catalog: found('catalog', { issued_at: 1 }) }),
  })), 'fact rows cannot carry freshness timestamps');
  expectInvalid(() => decideEmailLunaDraftPolicy({
    envelope: envelope(),
    evidence: createEmailLunaDraftPolicyEvidence(evidence()),
    ttl_ms: 0,
  }), 'decide input cannot extend freshness');
  expectInvalid(() => issueAndDecideEmailLunaDraftPolicy({
    envelope: envelope(),
    evidence: evidence(),
    run: () => {},
  }), 'canonical issue+decide cannot accept a callback or extra capability');
  expectInvalid(() => decideEmailLunaDraftPolicy({
    envelope: envelope(),
    evidence: frozen(evidence()),
  }), 'unissued lookalike evidence remains invalid');
  const rebound = canonicalIssue();
  assert.equal(rebound.decision.status, 'draft_ready');
  expectInvalid(() => decideEmailLunaDraftPolicy({
    envelope: envelope({ body_text: 'A later question.' }),
    evidence: rebound.evidence,
  }), 'rebound envelope remains invalid');
  console.log('  PASS  email/model/request inputs cannot select or extend freshness; unissued/rebound stay fail-closed');

  const toolIssue = canonicalIssue({
    grounded_results: frozen({
      catalog: frozen(Object.assign(Object.create(null), {
        type: 'handoff_required', fact: 'catalog', status: 'handoff_required', reason: 'tool_error',
        client_id: IDS.client_id, location_id: IDS.location_id,
      })),
    }),
  });
  assertHandoff(toolIssue.decision, 'tool_error');
  const missingIssue = canonicalIssue({
    grounded_results: frozen({
      catalog: frozen(Object.assign(Object.create(null), {
        type: 'missing_fact', fact: 'catalog', status: 'missing_fact', reason: 'not_found',
        client_id: IDS.client_id, location_id: IDS.location_id,
      })),
    }),
  });
  assertHandoff(missingIssue.decision, 'missing_required_facts');
  console.log('  PASS  tool failure and missing facts remain typed fail-closed outcomes');

  expectInvalid(() => issueAndDecideEmailLunaDraftPolicy({
    envelope: envelope(),
    evidence: evidence({ language: 'fr' }),
  }), 'canonical issue+decide fails closed on invalid producer input');
  const afterError = issueAndDecideEmailLunaDraftPolicy({ envelope: envelope(), evidence: evidence() });
  assert.equal(afterError.decision.status, 'draft_ready', 'freshness scope must exit on errors');
  assert.equal(issueAndDecideEmailLunaDraftPolicy.length, 1, 'canonical operation is not a callback scope');
  const hostileProducer = { ...evidence() };
  Object.defineProperty(hostileProducer, 'language', {
    enumerable: true,
    configurable: true,
    get() {
      issueAndDecideEmailLunaDraftPolicy({ envelope: envelope(), evidence: evidence() });
      return 'en';
    },
  });
  expectInvalid(
    () => issueAndDecideEmailLunaDraftPolicy({ envelope: envelope(), evidence: hostileProducer }),
    'reentrant canonical issue+decide cannot extend freshness scope',
  );
  const afterReentrant = issueAndDecideEmailLunaDraftPolicy({ envelope: envelope(), evidence: evidence() });
  assert.equal(afterReentrant.decision.status, 'draft_ready', 'failed reentry must still exit the outer scope');
  console.log('  PASS  synchronous canonical issue+decide works; scope always exits; no reentrant/callback extension');

  const policyModule = require('./lib/email-luna-draft-policy');
  assert.deepEqual(Object.keys(policyModule).sort(), [
    'EMAIL_LUNA_DRAFT_POLICY_HANDOFF_REASONS',
    'EMAIL_LUNA_DRAFT_POLICY_VERSION',
    'assertEmailLunaDraftPolicyIssuance',
    'createEmailLunaAutomationIssuanceMaterialStore',
    'createEmailLunaDraftPolicyEvidence',
    'decideEmailLunaDraftPolicy',
    'issueAndDecideEmailLunaDraftPolicy',
    'readEmailLunaDraftPolicyIssuanceIdentity',
  ]);
  assert.equal('recoverIssueAndDecideEmailLunaDraftPolicy' in policyModule, false);
  assert.equal('installIssuanceMaterialStoreFactory' in policyModule, false);
  for (const forbidden of [
    'recoverIssueAndDecideEmailLunaDraftPolicy',
    'installIssuanceMaterialStoreFactory',
    'createEmailLunaDraftPolicyClock',
    'createEmailLunaDraftPolicyFreshness',
    'getEmailLunaDraftPolicyFreshness',
    'advanceEmailLunaDraftPolicyTurn',
    'inspectIssuedEvidenceFreshness',
    'stampIssuedEvidenceFreshness',
    'scheduleCompositionTurnRetire',
    'enterFreshnessScope',
    'exitFreshnessScope',
    'withFreshnessScope',
    'runInFreshnessScope',
  ]) {
    assert.equal(forbidden in policyModule, false, `${forbidden} must stay private`);
  }
  assert.equal(EMAIL_LUNA_DRAFT_POLICY_HANDOFF_REASONS.includes('stale_evidence'), true);
  const policySrc = fs.readFileSync(POLICY_PATH, 'utf8');
  assert.equal(/\bDate\.now\b/.test(policySrc), false);
  assert.equal(/\bperformance\.now\b/.test(policySrc), false);
  assert.equal(/\bsetTimeout\b/.test(policySrc), false);
  assert.equal(/\bsetInterval\b/.test(policySrc), false);
  assert.equal(/\bsetImmediate\b/.test(policySrc), false);
  assert.equal(/\bnextTick\b/.test(policySrc), false);
  assert.equal(/\bPromise\b/.test(policySrc), false);
  assert.equal(/\bttl\b/i.test(policySrc), false);
  assert.equal(/\bissued_at\b/.test(policySrc), false);
  assert.equal(/\bexpires_at\b/.test(policySrc), false);
  assert.equal(/\bqueueMicrotask\b/.test(policySrc), false);
  assert.equal(/\bscheduleCompositionTurnRetire\b/.test(policySrc), false);
  assert.equal(/\bcompositionTurnRetireQueued\b/.test(policySrc), false);
  assert.equal(/\bstampIssuedEvidenceFreshness\b/.test(policySrc), true);
  assert.equal(/\binspectIssuedEvidenceFreshness\b/.test(policySrc), true);
  assert.equal(/\bissueAndDecideEmailLunaDraftPolicy\b/.test(policySrc), true);
  assert.match(policySrc, /if \(turn > freshnessScopeGeneration\) return 'future'/);
  assert.match(policySrc, /return 'malformed'/);
  const autonomousSrc = fs.readFileSync(AUTONOMOUS_PATH, 'utf8');
  assert.equal(/\bqueueMicrotask\b/.test(autonomousSrc), false);
  assert.equal(/\bstampIssuedEvidenceFreshness\b/.test(autonomousSrc), false);
  assert.equal(/\bcompositionTurn\b/.test(autonomousSrc), false);
  assert.equal(/\bfreshnessScopeOpen\b/.test(autonomousSrc), false);
  console.log('  PASS  freshness authority is private, factory-owned, and not a public clock/TTL API');

  const compositionSrc = fs.readFileSync(COMPOSITION_PATH, 'utf8');
  assert.equal(occurrences(compositionSrc, COMPOSITION_ISSUE_DECIDE), 1, 'canonical production composition must use one synchronous issue-and-decide operation');
  assert.equal(/\bcreateEmailLunaDraftPolicyEvidence\b/.test(compositionSrc), false, 'composition must not issue evidence outside the canonical operation');
  assert.equal(/\bdecideEmailLunaDraftPolicy\b/.test(compositionSrc), false, 'composition must not decide outside the canonical operation');
  const afterGrounded = compositionSrc.split('groundedResults = await collectGroundedResults')[1];
  const beforeAuthor = afterGrounded.split('authorDraft')[0];
  assert.equal(/\bissueAndDecideEmailLunaDraftPolicy\b/.test(beforeAuthor), true, 'canonical operation runs after grounded tool awaits');
  assert.equal(/\bawait\b/.test(beforeAuthor.split('issueAndDecideEmailLunaDraftPolicy')[1]), false, 'production composition must not await between issue-and-decide and authoring');
  assert.equal(/\bqueueMicrotask\b/.test(compositionSrc), false, 'composition must not own a second scheduler');

  const catalogRow = {
    fact: 'catalog',
    status: 'found',
    client_id: IDS.client_id,
    location_id: IDS.location_id,
    item: 'board_rental',
    label: 'Board rental',
    currency: 'EUR',
    amount_cents: 2000,
    active: true,
  };
  const noopOwner = () => Promise.resolve(catalogRow);
  const composed = await createEmailLunaDraftOpenPolicyComposition({
    classifyIntent: () => ({
      identity: 'matched',
      intent: 'catalog_question',
      intent_support: 'supported',
      language: 'en',
      requested_location_id: IDS.location_id,
      explicit_human_request: false,
      attachment_interpretation_required: false,
      unsafe_transactional_request: false,
      required_facts: ['catalog'],
    }),
    queryOwners: {
      catalog: () => Promise.resolve(catalogRow),
      availability: noopOwner,
      policy: noopOwner,
      booking: noopOwner,
      payment: noopOwner,
    },
    createLunaRuntime: () => ({
      authorDraft: async (request) => {
        assert.equal(request.decision.status, 'draft_ready');
        assertEmailLunaDraftPolicyIssuance(request);
        return Object.freeze({
          status: 'draft_ready',
          body: 'Hi,\n\nOur surfboard rental is €20.00.\n\nLuna',
          language: 'en',
          client_id: IDS.client_id,
          location_id: IDS.location_id,
          conversation_id: IDS.conversation_id,
          draft_only: true,
          requires_staff_review: true,
          send_allowed: false,
          auto_send_allowed: false,
        });
      },
    }),
  }).compose({
    authority: authority(),
    untrusted_content: content(),
    env: {
      LUNA_DEPLOYMENT: 'sunset-staging',
      EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
    },
  });
  assert.equal(composed.status, 'draft_ready');
  assert.equal(composed.kind, 'authored');
  assert.equal(composed.send_allowed, false);
  console.log('  PASS  canonical production composition remains synchronous issue-then-decide and still authors');

  const source = fs.readFileSync(POLICY_PATH, 'utf8');
  const bypass = loadPolicyVariant(
    'bypass-check',
    replaceUnique(source, FRESHNESS_CHECK_BLOCK, FRESHNESS_CHECK_BYPASS, 'bypass freshness inspect'),
  );
  try {
    const mutantEnv = bypass.handoff.createEmailLunaDraftEnvelope({
      authority: authority(),
      untrusted_content: content(),
    });
    const mutantIssued = bypass.policy.createEmailLunaDraftPolicyEvidence(evidence());
    assert.equal(
      bypass.policy.decideEmailLunaDraftPolicy({ envelope: mutantEnv, evidence: mutantIssued }).status,
      'draft_ready',
      'freshness-check mutant must keep retained evidence draft_ready',
    );
  } finally {
    fs.rmSync(bypass.root, { recursive: true, force: true });
  }

  const skipStamp = loadPolicyVariant(
    'skip-stamp',
    replaceUnique(source, FRESHNESS_STAMP_BLOCK, FRESHNESS_STAMP_REMOVED, 'remove freshness stamp'),
  );
  try {
    const mutantEnv = skipStamp.handoff.createEmailLunaDraftEnvelope({
      authority: authority(),
      untrusted_content: content(),
    });
    expectInvalid(
      () => skipStamp.policy.issueAndDecideEmailLunaDraftPolicy({ envelope: mutantEnv, evidence: evidence() }),
      'missing freshness metadata must fail closed',
    );
  } finally {
    fs.rmSync(skipStamp.root, { recursive: true, force: true });
  }

  const skipExit = loadPolicyVariant(
    'skip-scope-exit',
    replaceUnique(source, SCOPE_EXIT_BLOCK, SCOPE_EXIT_REMOVED, 'remove structural freshness scope exit'),
  );
  try {
    const mutantEnv = skipExit.handoff.createEmailLunaDraftEnvelope({
      authority: authority(),
      untrusted_content: content(),
    });
    const mutantIssued = skipExit.policy.issueAndDecideEmailLunaDraftPolicy({
      envelope: mutantEnv, evidence: evidence(),
    });
    assert.equal(mutantIssued.decision.status, 'draft_ready');
    assert.equal(
      skipExit.policy.decideEmailLunaDraftPolicy({ envelope: mutantEnv, evidence: mutantIssued.evidence }).status,
      'draft_ready',
      'structural-scope mutant must keep retained evidence draft_ready',
    );
  } finally {
    fs.rmSync(skipExit.root, { recursive: true, force: true });
  }

  const fresh = canonicalIssue();
  assert.equal(fresh.decision.status, 'draft_ready');
  assertHandoff(decideEmailLunaDraftPolicy({ envelope: fresh.envelope, evidence: fresh.evidence }), 'stale_evidence');
  console.log('  PASS  mutation isolation kills freshness-check bypass and structural-scope removal');
  console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch1 Slice B same-composition-turn freshness');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
