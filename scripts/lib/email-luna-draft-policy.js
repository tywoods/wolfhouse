'use strict';

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);
const { createEmailLunaDraftHandoff } = require('./email-luna-draft-handoff-contract');

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
]);

const INPUT_KEYS = objectFreeze(['envelope', 'evidence']);
const EVIDENCE_KEYS = objectFreeze([
  'client_id',
  'location_id',
  'conversation_id',
  'identity',
  'intent',
  'intent_support',
  'requested_location_id',
  'explicit_human_request',
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
  const evidence = exactFrozenRecord(request.evidence, EVIDENCE_KEYS, Object.prototype);
  const callerRequiredFacts = exactFrozenStringArray(evidence.required_facts);
  for (let index = 0; index < callerRequiredFacts.length; index += 1) {
    if (!arrayIncludes(FACTS, callerRequiredFacts[index])) throw invalid();
    for (let prior = 0; prior < index; prior += 1) if (callerRequiredFacts[prior] === callerRequiredFacts[index]) throw invalid();
  }

  if (typeof evidence.client_id !== 'string' || typeof evidence.location_id !== 'string'
      || typeof evidence.conversation_id !== 'string' || typeof evidence.requested_location_id !== 'string'
      || typeof evidence.identity !== 'string' || typeof evidence.intent !== 'string'
      || typeof evidence.intent_support !== 'string' || typeof evidence.explicit_human_request !== 'boolean'
      || typeof evidence.unsafe_transactional_request !== 'boolean') throw invalid();
  const intentSupported = objectHasOwn(INTENT_REQUIRED_FACTS, evidence.intent);
  const requiredFacts = intentSupported ? INTENT_REQUIRED_FACTS[evidence.intent] : callerRequiredFacts;
  const results = frozenResults(evidence.grounded_results, requiredFacts);

  if (evidence.conversation_id !== trusted.binding.conversation_id) {
    return handoff('authority_mismatch', trusted.binding);
  }
  if (hasInjection(trusted.untrustedContent)) return handoff('prompt_injection_detected', trusted.binding);
  if (evidence.client_id !== trusted.binding.client_id || evidence.location_id !== trusted.binding.location_id) {
    return handoff('authority_mismatch', trusted.binding);
  }
  if (evidence.explicit_human_request) return handoff('explicit_human_request', trusted.binding);
  if (evidence.unsafe_transactional_request) return handoff('unsafe_transactional_request', trusted.binding);
  if (evidence.requested_location_id !== trusted.binding.location_id) return handoff('cross_location_request', trusted.binding);
  if (evidence.identity !== 'matched') return handoff('ambiguous_identity', trusted.binding);
  if (evidence.intent_support === 'uncertain' || evidence.intent === 'uncertain') return handoff('uncertain_intent', trusted.binding);
  if (!intentSupported || evidence.intent_support !== 'supported') return handoff('unsupported_intent', trusted.binding);

  for (let index = 0; index < requiredFacts.length; index += 1) {
    const result = results[requiredFacts[index]];
    if (result.client_id !== trusted.binding.client_id || result.location_id !== trusted.binding.location_id) {
      return handoff('authority_mismatch', trusted.binding);
    }
    if (result.status === 'handoff_required') {
      return handoff(result.reason === 'authority_mismatch' ? 'authority_mismatch' : 'tool_error', trusted.binding);
    }
    if (result.status === 'missing_fact') return handoff('missing_required_facts', trusted.binding);
  }

  const groundedFacts = [];
  for (let index = 0; index < requiredFacts.length; index += 1) arrayPush(groundedFacts, requiredFacts[index]);
  objectFreeze(groundedFacts);
  return output([
    ['status', 'draft_ready'], ['intent', evidence.intent],
    ['client_id', trusted.binding.client_id], ['location_id', trusted.binding.location_id],
    ['conversation_id', trusted.binding.conversation_id], ['grounded_facts', groundedFacts],
    ['draft_only', true], ['requires_staff_review', true],
    ['send_allowed', false], ['auto_send_allowed', false],
  ]);
}

module.exports = { decideEmailLunaDraftPolicy, EMAIL_LUNA_DRAFT_POLICY_HANDOFF_REASONS };
