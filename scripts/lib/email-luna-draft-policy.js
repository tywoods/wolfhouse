'use strict';

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);
const nodeCrypto = require('node:crypto');
const { createEmailLunaDraftHandoff, createEmailLunaDraftEnvelope } = require('./email-luna-draft-handoff-contract');
const cryptoRandomUUID = typeof nodeCrypto.randomUUID === 'function' ? nodeCrypto.randomUUID.bind(nodeCrypto) : null;
const cryptoCreateHash = typeof nodeCrypto.createHash === 'function' ? nodeCrypto.createHash.bind(nodeCrypto) : null;

const arrayIncludes = uncurryThis(Array.prototype.includes);
const arrayPush = uncurryThis(Array.prototype.push);
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const objectIsFrozen = Object.isFrozen;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const regexpTest = uncurryThis(RegExp.prototype.test);
const numberIsSafeInteger = Number.isSafeInteger;
const numberIsFinite = Number.isFinite;
const weakSetAdd = uncurryThis(WeakSet.prototype.add);
const weakSetHas = uncurryThis(WeakSet.prototype.has);
const AUTHENTIC_POLICY_EVIDENCE = new WeakSet();
const AUTHENTIC_POLICY_DECISIONS = new WeakSet();
const POLICY_EVIDENCE_ENVELOPES = new WeakMap();
const POLICY_DECISION_ISSUANCE = new WeakMap();
const POLICY_EVIDENCE_FRESHNESS = new WeakMap();
const POLICY_ISSUANCE_IDS = new WeakMap();
const FRESHNESS_KEYS = objectFreeze(['turn']);
const EMAIL_LUNA_DRAFT_POLICY_VERSION = 'email-luna-draft-policy.v1';
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_CANON = /^[0-9a-f]{64}$/;
let freshnessScopeOpen = false;
let freshnessScopeGeneration = 0;

const EMAIL_LUNA_DRAFT_POLICY_HANDOFF_REASONS = objectFreeze([
  'ambiguous_identity',
  'uncertain_intent',
  'unsupported_intent',
  'missing_required_facts',
  'tool_error',
  'authority_mismatch',
  'cross_location_request',
  'explicit_human_request',
  'prompt_injection_detected',
  'unsafe_transactional_request',
  'stale_evidence',
]);

const INPUT_KEYS = objectFreeze(['envelope', 'evidence']);
const EVIDENCE_KEYS = objectFreeze([
  'client_id',
  'location_id',
  'conversation_id',
  'endpoint_id',
  'language',
  'identity',
  'intent',
  'intent_support',
  'requested_location_id',
  'explicit_human_request',
  'attachment_interpretation_required',
  'unsafe_transactional_request',
  'required_facts',
  'grounded_results',
]);
const ENVELOPE_KEYS = objectFreeze(['authority', 'untrusted_content', 'content_trust']);
const AUTHORITY_KEYS = objectFreeze([
  'client_id', 'location_id', 'location_key', 'conversation_id', 'endpoint_id', 'inbound_message_id',
]);
const CONTENT_KEYS = objectFreeze([
  'subject', 'body_text', 'quoted_history', 'from_display_name', 'from_address',
]);
const FACTS = objectFreeze(['catalog', 'availability', 'policy', 'booking', 'payment']);
const INTENT_REQUIRED_FACTS = objectFreeze({
  catalog_question: objectFreeze(['catalog']),
  availability_question: objectFreeze(['availability']),
  policy_question: objectFreeze(['policy']),
  booking_status_question: objectFreeze(['booking']),
  payment_status_question: objectFreeze(['payment']),
});
const CORE_RESULT_KEYS = objectFreeze(['fact', 'status', 'client_id', 'location_id']);
const FOUND_FIELDS = objectFreeze({
  catalog: objectFreeze(['item', 'label', 'currency', 'amount_cents', 'active']),
  availability: objectFreeze(['item', 'label', 'date', 'slot_time', 'available', 'capacity']),
  policy: objectFreeze(['label', 'policy_key', 'policy_text']),
  booking: objectFreeze(['label', 'booking_code', 'booking_status', 'check_in', 'check_out', 'guest_count']),
  payment: objectFreeze(['label', 'currency', 'payment_status', 'amount_paid_cents', 'balance_due_cents']),
});
const REQUIRED_FOUND_FIELDS = objectFreeze({
  catalog: objectFreeze(['item', 'label', 'currency', 'amount_cents', 'active']),
  availability: objectFreeze(['item', 'label', 'date', 'slot_time', 'available', 'capacity']),
  policy: objectFreeze(['label', 'policy_key', 'policy_text']),
  booking: objectFreeze(['booking_code', 'booking_status']),
  payment: objectFreeze(['currency', 'payment_status', 'amount_paid_cents', 'balance_due_cents']),
});
const FOUND_FIELD_TYPES = objectFreeze({
  item: 'string', label: 'string', currency: 'string', amount_cents: 'number', active: 'boolean',
  date: 'string', slot_time: 'string', available: 'boolean', capacity: 'number',
  policy_key: 'string', policy_text: 'string', booking_code: 'string', booking_status: 'string',
  check_in: 'string', check_out: 'string', guest_count: 'number', payment_status: 'string',
  amount_paid_cents: 'number', balance_due_cents: 'number',
});
const FAILURE_KEYS = objectFreeze(['type', 'fact', 'status', 'reason', 'client_id', 'location_id']);
const INJECTION = /(?:\bsystem\s*:|\[\s*system\s*\]|\bdeveloper\s+(?:message|instruction)|ignore\s+(?:all\s+)?previous\s+instructions?|override\s+policy|switch\s+tenant|call\s+[a-z_$][\w$]*\s*\(|<\s*\/?\s*system\b|\b(?:location_id|required_facts|send_allowed|draft_ready|low_confidence)\s*=|"(?:authority|policy|low_confidence)"\s*:)/i;

function invalid() {
  const error = new Error('Email Luna draft policy failed.');
  error.code = 'EMAIL_LUNA_DRAFT_POLICY_INVALID';
  return error;
}

function safeOwnKeys(value) {
  try {
    return reflectOwnKeys(value);
  } catch (_) {
    throw invalid();
  }
}

function exactFrozenRecord(value, keys, prototype) {
  if (value === null || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)) throw invalid();
  try {
    if (objectGetPrototypeOf(value) !== prototype || !objectIsFrozen(value)) throw invalid();
    const ownKeys = safeOwnKeys(value);
    if (ownKeys.length !== keys.length) throw invalid();
    const snapshot = objectCreate(null);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!arrayIncludes(ownKeys, key)) throw invalid();
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || !descriptor.enumerable
          || descriptor.writable || descriptor.configurable) throw invalid();
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (error && error.code === 'EMAIL_LUNA_DRAFT_POLICY_INVALID') throw error;
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
    if (error && error.code === 'EMAIL_LUNA_DRAFT_POLICY_INVALID') throw error;
    throw invalid();
  }
}

function authenticEnvelope(value) {
  let binding;
  try {
    binding = createEmailLunaDraftHandoff({ envelope: value, reason: 'authority_mismatch' });
  } catch (_) {
    throw invalid();
  }
  const envelope = exactFrozenRecord(value, ENVELOPE_KEYS, Object.prototype);
  const authority = exactFrozenRecord(envelope.authority, AUTHORITY_KEYS, Object.prototype);
  const untrustedContent = exactFrozenRecord(envelope.untrusted_content, CONTENT_KEYS, Object.prototype);
  if (envelope.content_trust !== 'untrusted_email_data_never_instructions') throw invalid();
  return { binding, authority, untrustedContent };
}

function exactFrozenStringArray(value) {
  if (value === null || typeof value !== 'object' || runtimeIsProxy(value) || !arrayIsArray(value)) throw invalid();
  try {
    if (objectGetPrototypeOf(value) !== Array.prototype || !objectIsFrozen(value)) throw invalid();
    const keys = safeOwnKeys(value);
    const lengthDescriptor = objectGetOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !objectHasOwn(lengthDescriptor, 'value')) throw invalid();
    const length = lengthDescriptor.value;
    if (!numberIsSafeInteger(length) || length < 0 || keys.length !== length + 1) throw invalid();
    const copy = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = objectGetOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.writable || descriptor.configurable
          || !descriptor.enumerable || typeof descriptor.value !== 'string') throw invalid();
      arrayPush(copy, descriptor.value);
    }
    return copy;
  } catch (error) {
    if (error && error.code === 'EMAIL_LUNA_DRAFT_POLICY_INVALID') throw error;
    throw invalid();
  }
}

function resultKeys(fact) {
  const keys = [];
  for (let index = 0; index < CORE_RESULT_KEYS.length; index += 1) arrayPush(keys, CORE_RESULT_KEYS[index]);
  const fields = FOUND_FIELDS[fact];
  for (let index = 0; index < fields.length; index += 1) arrayPush(keys, fields[index]);
  return keys;
}

function frozenResult(value, fact) {
  if (value === null || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)) throw invalid();
  let ownKeys;
  try {
    if (objectGetPrototypeOf(value) !== null || !objectIsFrozen(value)) throw invalid();
    ownKeys = safeOwnKeys(value);
  } catch (error) {
    if (error && error.code === 'EMAIL_LUNA_DRAFT_POLICY_INVALID') throw error;
    throw invalid();
  }
  let allowed;
  if (arrayIncludes(ownKeys, 'type')) allowed = FAILURE_KEYS;
  else allowed = resultKeys(fact);
  if (ownKeys.length > allowed.length) throw invalid();
  const snapshot = objectCreate(null);
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (typeof key !== 'string' || !arrayIncludes(allowed, key)) throw invalid();
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (!descriptor || !objectHasOwn(descriptor, 'value') || !descriptor.enumerable
        || descriptor.writable || descriptor.configurable) throw invalid();
    const item = descriptor.value;
    if (item !== null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') throw invalid();
    snapshot[key] = item;
  }
  const required = arrayIncludes(ownKeys, 'type') ? FAILURE_KEYS : CORE_RESULT_KEYS;
  for (let index = 0; index < required.length; index += 1) if (!objectHasOwn(snapshot, required[index])) throw invalid();
  if (snapshot.fact !== fact) throw invalid();
  if (objectHasOwn(snapshot, 'type')) {
    if (snapshot.type !== snapshot.status
        || (snapshot.type !== 'missing_fact' && snapshot.type !== 'handoff_required')) throw invalid();
    if (snapshot.type === 'missing_fact'
        && snapshot.reason !== 'not_found' && snapshot.reason !== 'malformed_fact') throw invalid();
    if (snapshot.type === 'handoff_required'
        && snapshot.reason !== 'tool_error' && snapshot.reason !== 'authority_mismatch') throw invalid();
  } else {
    if (snapshot.status !== 'found') throw invalid();
    const requiredFields = REQUIRED_FOUND_FIELDS[fact];
    for (let index = 0; index < requiredFields.length; index += 1) {
      if (!objectHasOwn(snapshot, requiredFields[index])) throw invalid();
    }
    const factFields = FOUND_FIELDS[fact];
    for (let index = 0; index < factFields.length; index += 1) {
      const field = factFields[index];
      if (!objectHasOwn(snapshot, field)) continue;
      const expectedType = FOUND_FIELD_TYPES[field];
      if (typeof snapshot[field] !== expectedType
          || (expectedType === 'number' && !numberIsFinite(snapshot[field]))) throw invalid();
    }
  }
  return snapshot;
}

function frozenResults(value, requiredFacts) {
  if (value === null || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)) throw invalid();
  try {
    if (objectGetPrototypeOf(value) !== Object.prototype || !objectIsFrozen(value)) throw invalid();
    const keys = safeOwnKeys(value);
    if (keys.length !== requiredFacts.length) throw invalid();
    const results = objectCreate(null);
    for (let index = 0; index < requiredFacts.length; index += 1) {
      const fact = requiredFacts[index];
      if (!arrayIncludes(keys, fact)) throw invalid();
      const descriptor = objectGetOwnPropertyDescriptor(value, fact);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || !descriptor.enumerable
          || descriptor.writable || descriptor.configurable) throw invalid();
      results[fact] = frozenResult(descriptor.value, fact);
    }
    return results;
  } catch (error) {
    if (error && error.code === 'EMAIL_LUNA_DRAFT_POLICY_INVALID') throw error;
    throw invalid();
  }
}

function validateEvidenceScalars(evidence) {
  if (typeof evidence.client_id !== 'string' || typeof evidence.location_id !== 'string'
      || typeof evidence.conversation_id !== 'string' || typeof evidence.endpoint_id !== 'string'
      || typeof evidence.requested_location_id !== 'string'
      || typeof evidence.language !== 'string' || typeof evidence.identity !== 'string' || typeof evidence.intent !== 'string'
      || typeof evidence.intent_support !== 'string' || typeof evidence.explicit_human_request !== 'boolean'
      || typeof evidence.attachment_interpretation_required !== 'boolean'
      || typeof evidence.unsafe_transactional_request !== 'boolean') throw invalid();
  if (!arrayIncludes(['en', 'es'], evidence.language)
      || !arrayIncludes(['matched', 'ambiguous', 'uncertain'], evidence.identity)
      || !arrayIncludes(['supported', 'unsupported', 'uncertain'], evidence.intent_support)) throw invalid();
}

function copyExactProducerRecord(value, keys, prototype) {
  if (value === null || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)) throw invalid();
  try {
    if (objectGetPrototypeOf(value) !== prototype) throw invalid();
    const ownKeys = safeOwnKeys(value);
    if (ownKeys.length !== keys.length) throw invalid();
    const copy = objectCreate(null);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!arrayIncludes(ownKeys, key)) throw invalid();
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || !descriptor.enumerable) throw invalid();
      copy[key] = descriptor.value;
    }
    return copy;
  } catch (error) {
    if (error && error.code === 'EMAIL_LUNA_DRAFT_POLICY_INVALID') throw error;
    throw invalid();
  }
}

function copyRequiredFacts(value) {
  if (value === null || typeof value !== 'object' || runtimeIsProxy(value) || !arrayIsArray(value)
      || objectGetPrototypeOf(value) !== Array.prototype) throw invalid();
  const keys = safeOwnKeys(value);
  const lengthDescriptor = objectGetOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !objectHasOwn(lengthDescriptor, 'value')) throw invalid();
  const length = lengthDescriptor.value;
  if (!numberIsSafeInteger(length) || length < 0 || keys.length !== length + 1) throw invalid();
  const copy = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = objectGetOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !objectHasOwn(descriptor, 'value') || !descriptor.enumerable
        || typeof descriptor.value !== 'string' || !arrayIncludes(FACTS, descriptor.value)) throw invalid();
    for (let prior = 0; prior < index; prior += 1) if (copy[prior] === descriptor.value) throw invalid();
    arrayPush(copy, descriptor.value);
  }
  return objectFreeze(copy);
}

function frozenFreshness(turn) {
  const record = objectCreate(null);
  objectDefineProperty(record, 'turn', {
    value: turn, enumerable: true, writable: false, configurable: false,
  });
  return objectFreeze(record);
}

function stampIssuedEvidenceFreshness(issued) {
  if (POLICY_EVIDENCE_FRESHNESS.get(issued) !== undefined) throw invalid();
  const live = freshnessScopeOpen
    && numberIsSafeInteger(freshnessScopeGeneration)
    && freshnessScopeGeneration > 0;
  POLICY_EVIDENCE_FRESHNESS.set(issued, frozenFreshness(live ? freshnessScopeGeneration : 0));
}

function inspectIssuedEvidenceFreshness(evidence) {
  const record = POLICY_EVIDENCE_FRESHNESS.get(evidence);
  if (record === undefined) return 'missing';
  let snapshot;
  try {
    snapshot = exactFrozenRecord(record, FRESHNESS_KEYS, null);
  } catch (_) {
    return 'malformed';
  }
  const turn = snapshot.turn;
  if (!numberIsSafeInteger(turn) || turn < 0) return 'malformed';
  if (!freshnessScopeOpen) return 'stale';
  if (turn === 0) return 'stale';
  if (turn > freshnessScopeGeneration) return 'future';
  if (turn !== freshnessScopeGeneration) return 'stale';
  return 'fresh';
}

function copyGroundedResult(value, fact) {
  if (value === null || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)) throw invalid();
  const prototype = objectGetPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw invalid();
  const ownKeys = safeOwnKeys(value);
  const allowed = arrayIncludes(ownKeys, 'type') ? FAILURE_KEYS : resultKeys(fact);
  if (ownKeys.length > allowed.length) throw invalid();
  const copy = objectCreate(null);
  for (let index = 0; index < ownKeys.length; index += 1) {
    const key = ownKeys[index];
    if (typeof key !== 'string' || !arrayIncludes(allowed, key)) throw invalid();
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (!descriptor || !objectHasOwn(descriptor, 'value') || !descriptor.enumerable) throw invalid();
    const item = descriptor.value;
    if (item !== null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') throw invalid();
    objectDefineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
  }
  objectFreeze(copy);
  frozenResult(copy, fact);
  return copy;
}

/**
 * Trusted server-composition boundary only. It copies and brands supplied
 * classifier/tool snapshots; it does not classify email or infer truth.
 */
function createEmailLunaDraftPolicyEvidence(input) {
  const evidence = copyExactProducerRecord(input, EVIDENCE_KEYS, Object.prototype);
  validateEvidenceScalars(evidence);
  const requiredFacts = copyRequiredFacts(evidence.required_facts);
  const intentSupported = objectHasOwn(INTENT_REQUIRED_FACTS, evidence.intent);
  const policyFacts = intentSupported ? INTENT_REQUIRED_FACTS[evidence.intent] : requiredFacts;
  const sourceResults = copyExactProducerRecord(evidence.grounded_results, policyFacts, Object.prototype);
  const groundedResults = {};
  for (let index = 0; index < policyFacts.length; index += 1) {
    const fact = policyFacts[index];
    groundedResults[fact] = copyGroundedResult(sourceResults[fact], fact);
  }
  objectFreeze(groundedResults);
  const issued = objectFreeze({
    client_id: evidence.client_id,
    location_id: evidence.location_id,
    conversation_id: evidence.conversation_id,
    endpoint_id: evidence.endpoint_id,
    language: evidence.language,
    identity: evidence.identity,
    intent: evidence.intent,
    intent_support: evidence.intent_support,
    requested_location_id: evidence.requested_location_id,
    explicit_human_request: evidence.explicit_human_request,
    attachment_interpretation_required: evidence.attachment_interpretation_required,
    unsafe_transactional_request: evidence.unsafe_transactional_request,
    required_facts: requiredFacts,
    grounded_results: groundedResults,
  });
  weakSetAdd(AUTHENTIC_POLICY_EVIDENCE, issued);
  stampIssuedEvidenceFreshness(issued);
  return issued;
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

function issueDecision(decision, envelope, evidence) {
  weakSetAdd(AUTHENTIC_POLICY_DECISIONS, decision);
  POLICY_DECISION_ISSUANCE.set(decision, objectFreeze({
    envelope,
    evidence,
  }));
  return decision;
}

function hasInjection(content) {
  for (let index = 0; index < CONTENT_KEYS.length; index += 1) {
    const value = content[CONTENT_KEYS[index]];
    if (typeof value !== 'string') throw invalid();
    if (regexpTest(INJECTION, value)) return true;
  }
  return false;
}

function decideEmailLunaDraftPolicy(input) {
  const request = exactInput(input);
  const trusted = authenticEnvelope(request.envelope);
  if (!request.evidence || !weakSetHas(AUTHENTIC_POLICY_EVIDENCE, request.evidence)) throw invalid();
  const boundEnvelope = POLICY_EVIDENCE_ENVELOPES.get(request.evidence);
  if (boundEnvelope !== undefined && boundEnvelope !== request.envelope) throw invalid();
  POLICY_EVIDENCE_ENVELOPES.set(request.evidence, request.envelope);
  const evidence = exactFrozenRecord(request.evidence, EVIDENCE_KEYS, Object.prototype);
  const callerRequiredFacts = exactFrozenStringArray(evidence.required_facts);
  for (let index = 0; index < callerRequiredFacts.length; index += 1) {
    if (!arrayIncludes(FACTS, callerRequiredFacts[index])) throw invalid();
    for (let prior = 0; prior < index; prior += 1) if (callerRequiredFacts[prior] === callerRequiredFacts[index]) throw invalid();
  }

  validateEvidenceScalars(evidence);
  const intentSupported = objectHasOwn(INTENT_REQUIRED_FACTS, evidence.intent);
  const requiredFacts = intentSupported ? INTENT_REQUIRED_FACTS[evidence.intent] : callerRequiredFacts;
  const results = frozenResults(evidence.grounded_results, requiredFacts);

  function finish(decision) {
    return issueDecision(decision, request.envelope, request.evidence);
  }

  const freshness = inspectIssuedEvidenceFreshness(request.evidence);
  if (freshness === 'stale') return finish(handoff('stale_evidence', trusted.binding));
  if (freshness !== 'fresh') throw invalid();

  if (evidence.conversation_id !== trusted.binding.conversation_id
      || evidence.endpoint_id !== trusted.authority.endpoint_id) {
    return finish(handoff('authority_mismatch', trusted.binding));
  }
  if (hasInjection(trusted.untrustedContent)) return finish(handoff('prompt_injection_detected', trusted.binding));
  if (evidence.client_id !== trusted.binding.client_id || evidence.location_id !== trusted.binding.location_id) {
    return finish(handoff('authority_mismatch', trusted.binding));
  }
  if (evidence.explicit_human_request) return finish(handoff('explicit_human_request', trusted.binding));
  if (evidence.unsafe_transactional_request) return finish(handoff('unsafe_transactional_request', trusted.binding));
  if (evidence.requested_location_id !== trusted.binding.location_id) return finish(handoff('cross_location_request', trusted.binding));
  if (evidence.identity !== 'matched') return finish(handoff('ambiguous_identity', trusted.binding));
  if (evidence.intent_support === 'uncertain' || evidence.intent === 'uncertain') return finish(handoff('uncertain_intent', trusted.binding));
  if (!intentSupported || evidence.intent_support !== 'supported') return finish(handoff('unsupported_intent', trusted.binding));

  for (let index = 0; index < requiredFacts.length; index += 1) {
    const result = results[requiredFacts[index]];
    if (result.client_id !== trusted.binding.client_id || result.location_id !== trusted.binding.location_id) {
      return finish(handoff('authority_mismatch', trusted.binding));
    }
    if (result.status === 'handoff_required') {
      return finish(handoff(result.reason === 'authority_mismatch' ? 'authority_mismatch' : 'tool_error', trusted.binding));
    }
    if (result.status === 'missing_fact') return finish(handoff('missing_required_facts', trusted.binding));
  }

  const groundedFacts = [];
  for (let index = 0; index < requiredFacts.length; index += 1) arrayPush(groundedFacts, requiredFacts[index]);
  objectFreeze(groundedFacts);
  return finish(output([
    ['status', 'draft_ready'], ['intent', evidence.intent], ['language', evidence.language],
    ['client_id', trusted.binding.client_id], ['location_id', trusted.binding.location_id],
    ['conversation_id', trusted.binding.conversation_id], ['grounded_facts', groundedFacts],
    ['draft_only', true], ['requires_staff_review', true],
    ['send_allowed', false], ['auto_send_allowed', false],
  ]));
}

function mintIssuanceIdentity(evidence) {
  if (!weakSetHas(AUTHENTIC_POLICY_EVIDENCE, evidence)) throw invalid();
  if (POLICY_ISSUANCE_IDS.get(evidence) !== undefined) throw invalid();
  if (!cryptoRandomUUID) throw invalid();
  let raw;
  try {
    raw = cryptoRandomUUID();
  } catch (_) {
    throw invalid();
  }
  if (typeof raw !== 'string') throw invalid();
  const id = raw.toLowerCase();
  if (!regexpTest(UUID_CANON, id)) throw invalid();
  POLICY_ISSUANCE_IDS.set(evidence, id);
  return id;
}

function readEmailLunaDraftPolicyIssuanceIdentity(value) {
  if (value === null || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)) throw invalid();
  const authentic = weakSetHas(AUTHENTIC_POLICY_EVIDENCE, value) || weakSetHas(AUTHENTIC_POLICY_DECISIONS, value);
  if (!authentic) throw invalid();
  const id = POLICY_ISSUANCE_IDS.get(value);
  if (typeof id !== 'string' || !regexpTest(UUID_CANON, id)) throw invalid();
  return id;
}

function openPolicyFreshnessTurn() {
  if (freshnessScopeOpen) throw invalid();
  if (!numberIsSafeInteger(freshnessScopeGeneration) || freshnessScopeGeneration >= Number.MAX_SAFE_INTEGER - 1) {
    throw invalid();
  }
  freshnessScopeOpen = true;
  freshnessScopeGeneration += 1;
}

function closePolicyFreshnessTurn() {
  freshnessScopeOpen = false;
  if (numberIsSafeInteger(freshnessScopeGeneration) && freshnessScopeGeneration < Number.MAX_SAFE_INTEGER) {
    freshnessScopeGeneration += 1;
  }
}

function issueAndDecideEmailLunaDraftPolicy(input) {
  const request = exactInput(input);
  if (freshnessScopeOpen) throw invalid();
  if (!numberIsSafeInteger(freshnessScopeGeneration) || freshnessScopeGeneration >= Number.MAX_SAFE_INTEGER - 1) {
    throw invalid();
  }
  freshnessScopeOpen = true;
  freshnessScopeGeneration += 1;
  try {
    const evidence = createEmailLunaDraftPolicyEvidence(request.evidence);
    const issuanceId = mintIssuanceIdentity(evidence);
    const decision = decideEmailLunaDraftPolicy({ envelope: request.envelope, evidence });
    POLICY_ISSUANCE_IDS.set(decision, issuanceId);
    return output([
      ['evidence', evidence],
      ['decision', decision],
    ]);
  } finally {
    freshnessScopeOpen = false;
    if (numberIsSafeInteger(freshnessScopeGeneration) && freshnessScopeGeneration < Number.MAX_SAFE_INTEGER) {
      freshnessScopeGeneration += 1;
    }
  }
}

/**
 * Recovery-only reconstitution. Private to this module. Binds the ORIGINAL
 * issuance_id onto newly branded evidence/decision during a new composition-turn.
 * Live composition must keep using issueAndDecideEmailLunaDraftPolicy (which mints).
 * Ordinary importers cannot obtain this function. Recovery is reachable only
 * through createEmailLunaAutomationIssuanceMaterialStore(...).recoverAutomationIssuance
 * after a WeakSet-branded scoped load.
 */
function recoverIssueAndDecideEmailLunaDraftPolicy(input) {
  const request = copyExactProducerRecord(input, ['envelope', 'evidence', 'issuance_id'], Object.prototype);
  if (typeof request.issuance_id !== 'string') throw invalid();
  const issuanceId = request.issuance_id.toLowerCase();
  if (!regexpTest(UUID_CANON, issuanceId) || request.issuance_id !== issuanceId) throw invalid();
  openPolicyFreshnessTurn();
  try {
    const evidence = createEmailLunaDraftPolicyEvidence(request.evidence);
    if (POLICY_ISSUANCE_IDS.get(evidence) !== undefined) throw invalid();
    POLICY_ISSUANCE_IDS.set(evidence, issuanceId);
    const decision = decideEmailLunaDraftPolicy({ envelope: request.envelope, evidence });
    if (POLICY_ISSUANCE_IDS.get(decision) !== undefined) throw invalid();
    POLICY_ISSUANCE_IDS.set(decision, issuanceId);
    return output([
      ['evidence', evidence],
      ['decision', decision],
    ]);
  } finally {
    closePolicyFreshnessTurn();
  }
}

function assertEmailLunaDraftPolicyIssuance(input) {
  const request = copyExactProducerRecord(input, ['envelope', 'decision', 'evidence'], Object.prototype);
  const trusted = authenticEnvelope(request.envelope);
  if (!weakSetHas(AUTHENTIC_POLICY_DECISIONS, request.decision)
      || !weakSetHas(AUTHENTIC_POLICY_EVIDENCE, request.evidence)) throw invalid();
  const issuance = POLICY_DECISION_ISSUANCE.get(request.decision);
  if (!issuance || issuance.envelope !== request.envelope || issuance.evidence !== request.evidence
      || POLICY_EVIDENCE_ENVELOPES.get(request.evidence) !== request.envelope) throw invalid();
  const evidence = exactFrozenRecord(request.evidence, EVIDENCE_KEYS, Object.prototype);
  const statusDescriptor = objectGetOwnPropertyDescriptor(request.decision, 'status');
  if (!statusDescriptor || !objectHasOwn(statusDescriptor, 'value')) throw invalid();
  if (statusDescriptor.value === 'handoff_required') {
    const decision = exactFrozenRecord(request.decision, [
      'status', 'reason', 'client_id', 'location_id', 'conversation_id',
      'draft_only', 'requires_staff_review', 'send_allowed', 'auto_send_allowed',
    ], null);
    if (decision.client_id !== trusted.binding.client_id || decision.location_id !== trusted.binding.location_id
        || decision.conversation_id !== trusted.binding.conversation_id
        || !arrayIncludes(EMAIL_LUNA_DRAFT_POLICY_HANDOFF_REASONS, decision.reason)
        || decision.draft_only !== true || decision.requires_staff_review !== true
        || decision.send_allowed !== false || decision.auto_send_allowed !== false) throw invalid();
    return objectFreeze({
      binding: trusted.binding, authority: objectFreeze({ ...trusted.authority }), language: evidence.language,
      untrusted_content: objectFreeze({ ...trusted.untrustedContent }), fact_ids: objectFreeze([]),
      grounded_facts: objectFreeze({}), status: 'handoff_required', reason: decision.reason,
      intent: evidence.intent, attachment_interpretation_required: evidence.attachment_interpretation_required,
    });
  }
  const decision = exactFrozenRecord(request.decision, [
    'status', 'intent', 'language', 'client_id', 'location_id', 'conversation_id', 'grounded_facts',
    'draft_only', 'requires_staff_review', 'send_allowed', 'auto_send_allowed',
  ], null);
  if (decision.status !== 'draft_ready' || decision.client_id !== trusted.binding.client_id
      || decision.location_id !== trusted.binding.location_id || decision.conversation_id !== trusted.binding.conversation_id
      || evidence.client_id !== trusted.binding.client_id || evidence.location_id !== trusted.binding.location_id
      || evidence.conversation_id !== trusted.binding.conversation_id
      || evidence.endpoint_id !== trusted.authority.endpoint_id
      || evidence.intent !== decision.intent || evidence.language !== decision.language) throw invalid();
  const factIds = exactFrozenStringArray(decision.grounded_facts);
  const results = frozenResults(evidence.grounded_results, factIds);
  const facts = objectCreate(null);
  for (let index = 0; index < factIds.length; index += 1) {
    const id = factIds[index]; const result = results[id];
    if (result.status !== 'found' || result.client_id !== trusted.binding.client_id
        || result.location_id !== trusted.binding.location_id) throw invalid();
    facts[id] = objectFreeze({ ...result });
  }
  return objectFreeze({
    binding: trusted.binding, authority: objectFreeze({ ...trusted.authority }), language: evidence.language,
    untrusted_content: objectFreeze({ ...trusted.untrustedContent }), fact_ids: objectFreeze(factIds),
    grounded_facts: objectFreeze(facts), status: 'draft_ready', intent: evidence.intent,
    attachment_interpretation_required: evidence.attachment_interpretation_required,
  });
}

function issuanceMaterialInvalid(error) {
  if (error && error.code === 'EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_INVALID') throw error;
  const failed = new Error('Email Luna automation issuance material failed.');
  failed.code = 'EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_INVALID';
  throw failed;
}

function digestCanonicalDraft(draft) {
  if (!cryptoCreateHash) throw invalid();
  if (draft === null || typeof draft !== 'object' || runtimeIsProxy(draft) || arrayIsArray(draft)) throw invalid();
  const subject = objectGetOwnPropertyDescriptor(draft, 'subject');
  const body = objectGetOwnPropertyDescriptor(draft, 'body');
  const language = objectGetOwnPropertyDescriptor(draft, 'language');
  if (!subject || !body || language === undefined || typeof subject.value !== 'string'
      || typeof body.value !== 'string' || typeof language.value !== 'string') throw invalid();
  const hasher = cryptoCreateHash('sha256');
  const feed = hasher.update.bind(hasher);
  feed(subject.value);
  feed('\0');
  feed(body.value);
  feed('\0');
  feed(language.value);
  const digest = hasher.digest('hex');
  if (typeof digest !== 'string' || !regexpTest(DIGEST_CANON, digest)) throw invalid();
  return digest;
}

function rebuildEvidenceSnapshotFromMaterial(material) {
  const {
    emailLunaDraftPolicyTextForKey,
  } = require('./email-luna-draft-author');
  const fact = material.required_facts[0];
  const stored = material.grounded_facts[fact];
  if (stored === null || typeof stored !== 'object' || runtimeIsProxy(stored) || arrayIsArray(stored)) throw invalid();
  const found = objectCreate(null);
  const storedKeys = reflectOwnKeys(stored);
  for (let index = 0; index < storedKeys.length; index += 1) {
    const key = storedKeys[index];
    if (typeof key !== 'string') throw invalid();
    found[key] = stored[key];
  }
  if (fact === 'policy') {
    const text = emailLunaDraftPolicyTextForKey(stored.policy_key, material.language);
    if (typeof text !== 'string') throw invalid();
    found.policy_text = text;
  }
  objectFreeze(found);
  const grounded = {};
  grounded[fact] = found;
  objectFreeze(grounded);
  return {
    client_id: material.client_id,
    location_id: material.location_id,
    conversation_id: material.conversation_id,
    endpoint_id: material.endpoint_id,
    language: material.language,
    identity: material.identity,
    intent: material.intent,
    intent_support: material.intent_support,
    requested_location_id: material.requested_location_id,
    explicit_human_request: material.explicit_human_request,
    attachment_interpretation_required: material.attachment_interpretation_required,
    unsafe_transactional_request: material.unsafe_transactional_request,
    required_facts: material.required_facts.slice(),
    grounded_results: grounded,
  };
}

function recoverFromLoadedIssuanceMaterial(material) {
  const {
    recoverEmailLunaDraftAuthorFromAuthenticPlan,
  } = require('./email-luna-draft-author');
  const { validateEmailLunaDraft } = require('./email-luna-draft-validator');
  const envelope = createEmailLunaDraftEnvelope({
    authority: {
      client_id: material.client_id,
      location_id: material.location_id,
      location_key: material.location_key,
      conversation_id: material.conversation_id,
      endpoint_id: material.endpoint_id,
      inbound_message_id: material.inbound_event_id,
    },
    untrusted_content: {
      subject: material.envelope_subject,
      body_text: material.envelope_body_text,
      quoted_history: '',
      from_display_name: material.envelope_from_display_name,
      from_address: material.envelope_from_address,
    },
  });
  const issued = recoverIssueAndDecideEmailLunaDraftPolicy({
    envelope,
    evidence: rebuildEvidenceSnapshotFromMaterial(material),
    issuance_id: material.issuance_id,
  });
  if (!issued || issued.decision.status !== 'draft_ready') throw invalid();
  if (readEmailLunaDraftPolicyIssuanceIdentity(issued.evidence) !== material.issuance_id) throw invalid();
  if (readEmailLunaDraftPolicyIssuanceIdentity(issued.decision) !== material.issuance_id) throw invalid();
  const plan = {
    template_id: material.template_id,
    tone: material.tone,
    question_key: material.question_key,
    acknowledgment_key: material.acknowledgment_key,
  };
  const draft = recoverEmailLunaDraftAuthorFromAuthenticPlan({
    envelope,
    evidence: issued.evidence,
    decision: issued.decision,
    plan,
  });
  if (digestCanonicalDraft(draft) !== material.draft_digest) throw invalid();
  const validation = validateEmailLunaDraft({
    envelope,
    evidence: issued.evidence,
    decision: issued.decision,
    draft,
  });
  if (validation.status !== 'valid') throw invalid();
  return objectFreeze({
    envelope,
    evidence: issued.evidence,
    decision: issued.decision,
    draft,
    validation,
    issuance_id: material.issuance_id,
    draft_digest: material.draft_digest,
    operation_id: material.operation_id,
  });
}

function createEmailLunaAutomationIssuanceMaterialStore(dependencies) {
  if (arguments.length !== 1) throw invalid();
  const storeMod = require('./email-luna-automation-issuance-material-store');
  const factory = storeMod.createEmailLunaAutomationIssuanceMaterialPersistence;
  if (typeof factory !== 'function' || runtimeIsProxy(factory) || factory.length !== 1) throw invalid();
  const raw = factory(dependencies);
  if (!raw || typeof raw !== 'object' || runtimeIsProxy(raw)
      || typeof raw.persistAndEnqueueAutomationIssuance !== 'function'
      || typeof raw.loadAutomationIssuanceMaterial !== 'function'
      || typeof raw.assertAuthenticLoadedMaterial !== 'function'
      || typeof raw.recoverAutomationIssuance === 'function') throw invalid();
  const persistAndEnqueueAutomationIssuance = raw.persistAndEnqueueAutomationIssuance;
  const loadAutomationIssuanceMaterial = raw.loadAutomationIssuanceMaterial;
  const assertAuthenticLoadedMaterial = raw.assertAuthenticLoadedMaterial;
  return objectFreeze({
    persistAndEnqueueAutomationIssuance,
    loadAutomationIssuanceMaterial,
    recoverAutomationIssuance(input) {
      try {
        const request = copyExactProducerRecord(input, ['material'], Object.prototype);
        assertAuthenticLoadedMaterial(request.material);
        return output([
          ['status', 'recovered'],
          ['record', recoverFromLoadedIssuanceMaterial(request.material)],
        ]);
      } catch (error) {
        issuanceMaterialInvalid(error);
      }
    },
  });
}

module.exports = objectFreeze({
  createEmailLunaDraftPolicyEvidence,
  decideEmailLunaDraftPolicy,
  issueAndDecideEmailLunaDraftPolicy,
  assertEmailLunaDraftPolicyIssuance,
  readEmailLunaDraftPolicyIssuanceIdentity,
  createEmailLunaAutomationIssuanceMaterialStore,
  EMAIL_LUNA_DRAFT_POLICY_HANDOFF_REASONS,
  EMAIL_LUNA_DRAFT_POLICY_VERSION,
});
