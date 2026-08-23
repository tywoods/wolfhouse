'use strict';

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);
const { createEmailLunaDraftHandoff } = require('./email-luna-draft-handoff-contract');
const { assertEmailLunaDraftPolicyIssuance } = require('./email-luna-draft-policy');

const arrayIncludes = uncurryThis(Array.prototype.includes);
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const weakSetAdd = uncurryThis(WeakSet.prototype.add);
const weakSetHas = uncurryThis(WeakSet.prototype.has);
const CONSUMED_POLICY_DECISIONS = new WeakSet();

const EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_HANDOFF_REASONS = objectFreeze([
  'ambiguous_identity',
  'missing_required_facts',
  'unissued_evidence',
  'stale_evidence',
  'unsupported_intent',
  'sensitive_intent',
  'attachment_interpretation_required',
  'prompt_injection_detected',
  'explicit_human_request',
  'authority_mismatch',
]);
const EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_INTENTS = objectFreeze([
  'catalog_question',
  'availability_question',
  'policy_question',
  'booking_status_question',
]);
const SENSITIVE_INTENTS = objectFreeze([
  'payment_dispute',
  'cancellation_request',
  'refund_request',
  'legal_request',
  'safety_request',
]);
const CANONICAL_HANDOFF_REASONS = objectFreeze({
  ambiguous_identity: 'ambiguous_identity',
  uncertain_intent: 'unsupported_intent',
  unsupported_intent: 'unsupported_intent',
  missing_required_facts: 'missing_required_facts',
  tool_error: 'missing_required_facts',
  authority_mismatch: 'authority_mismatch',
  cross_location_request: 'authority_mismatch',
  explicit_human_request: 'explicit_human_request',
  prompt_injection_detected: 'prompt_injection_detected',
  unsafe_transactional_request: 'sensitive_intent',
  stale_evidence: 'stale_evidence',
});
const INPUT_KEYS = objectFreeze(['envelope', 'evidence', 'decision']);

function invalid() {
  const error = new Error('Email Luna autonomous eligibility policy failed.');
  error.code = 'EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_INVALID';
  return error;
}

function safeOwnKeys(value) {
  try {
    return reflectOwnKeys(value);
  } catch (_) {
    throw invalid();
  }
}

function exactInput(value) {
  if (value === null || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)) throw invalid();
  try {
    if (objectGetPrototypeOf(value) !== Object.prototype) throw invalid();
    const ownKeys = safeOwnKeys(value);
    if (ownKeys.length !== INPUT_KEYS.length) throw invalid();
    const snapshot = objectCreate(null);
    for (let index = 0; index < INPUT_KEYS.length; index += 1) {
      const key = INPUT_KEYS[index];
      if (!arrayIncludes(ownKeys, key)) throw invalid();
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || !descriptor.enumerable) throw invalid();
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (error && error.code === 'EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_INVALID') throw error;
    throw invalid();
  }
}

function output(entries) {
  const value = objectCreate(null);
  for (let index = 0; index < entries.length; index += 1) {
    objectDefineProperty(value, entries[index][0], {
      value: entries[index][1], enumerable: true, writable: true, configurable: true,
    });
  }
  return objectFreeze(value);
}

function handoff(reason, binding) {
  return output([
    ['status', 'handoff_required'], ['reason', reason],
    ['client_id', binding.client_id], ['location_id', binding.location_id],
    ['conversation_id', binding.conversation_id], ['draft_only', true],
    ['requires_staff_review', true], ['send_allowed', false], ['auto_send_allowed', false],
  ]);
}

function decideEmailLunaAutonomousEligibility(input) {
  const request = exactInput(input);
  let binding;
  try {
    binding = createEmailLunaDraftHandoff({ envelope: request.envelope, reason: 'authority_mismatch' });
  } catch (_) {
    throw invalid();
  }
  let trusted;
  try {
    trusted = assertEmailLunaDraftPolicyIssuance({
      envelope: request.envelope,
      evidence: request.evidence,
      decision: request.decision,
    });
  } catch (_) {
    return handoff('unissued_evidence', binding);
  }
  if (trusted.status === 'handoff_required') {
    if (arrayIncludes(SENSITIVE_INTENTS, trusted.intent)) return handoff('sensitive_intent', binding);
    const mapped = CANONICAL_HANDOFF_REASONS[trusted.reason];
    if (typeof mapped !== 'string') throw invalid();
    return handoff(mapped, binding);
  }
  if (trusted.attachment_interpretation_required === true) {
    return handoff('attachment_interpretation_required', binding);
  }
  if (arrayIncludes(SENSITIVE_INTENTS, trusted.intent)) return handoff('sensitive_intent', binding);
  if (!arrayIncludes(EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_INTENTS, trusted.intent)) {
    return handoff('unsupported_intent', binding);
  }
  if (trusted.status !== 'draft_ready') throw invalid();
  if (weakSetHas(CONSUMED_POLICY_DECISIONS, request.decision)) {
    return handoff('stale_evidence', binding);
  }
  const eligible = output([
    ['status', 'eligible'], ['intent', trusted.intent], ['language', trusted.language],
    ['client_id', trusted.binding.client_id], ['location_id', trusted.binding.location_id],
    ['conversation_id', trusted.binding.conversation_id], ['grounded_facts', request.decision.grounded_facts],
    ['draft_only', true], ['requires_staff_review', true],
    ['send_allowed', false], ['auto_send_allowed', false],
  ]);
  weakSetAdd(CONSUMED_POLICY_DECISIONS, request.decision);
  return eligible;
}

module.exports = {
  decideEmailLunaAutonomousEligibility,
  EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_HANDOFF_REASONS,
  EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_INTENTS,
};
