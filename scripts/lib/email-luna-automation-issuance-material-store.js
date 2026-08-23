'use strict';

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);
const nodeCrypto = require('node:crypto');
const { createEmailLunaDraftEnvelope } = require('./email-luna-draft-handoff-contract');
const {
  assertEmailLunaDraftPolicyIssuance,
  readEmailLunaDraftPolicyIssuanceIdentity,
  EMAIL_LUNA_DRAFT_POLICY_VERSION,
} = require('./email-luna-draft-policy');
const {
  assertEmailLunaAutonomousEligibilityOutput,
  EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION,
} = require('./email-luna-autonomous-eligibility-policy');
const {
  recomputeEmailLunaDraftCanonicalFromAuthentic,
  readEmailLunaDraftAuthorPlan,
  recoverEmailLunaDraftAuthorFromAuthenticPlan,
  emailLunaDraftPolicyTextForKey,
} = require('./email-luna-draft-author');
const {
  assertEmailLunaDraftValidation,
  validateEmailLunaDraft,
  EMAIL_LUNA_DRAFT_VALIDATOR_VERSION,
} = require('./email-luna-draft-validator');

const arrayIncludes = uncurryThis(Array.prototype.includes);
const arrayPush = uncurryThis(Array.prototype.push);
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const objectKeys = Object.keys;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const regexpTest = uncurryThis(RegExp.prototype.test);
const stringTrim = uncurryThis(String.prototype.trim);
const stringToLowerCase = uncurryThis(String.prototype.toLowerCase);
const jsonStringify = JSON.stringify;
const jsonParse = JSON.parse;
const weakSetAdd = uncurryThis(WeakSet.prototype.add);
const weakSetHas = uncurryThis(WeakSet.prototype.has);
const cryptoCreateHash = typeof nodeCrypto.createHash === 'function' ? nodeCrypto.createHash.bind(nodeCrypto) : null;
const AUTHENTIC_LOADED_MATERIAL = new WeakSet();

const EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_RUNTIME_WIRED = false;
const EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_LOGGING_FORBIDDEN = true;
const DRAFT_POLICY_VERSION = EMAIL_LUNA_DRAFT_POLICY_VERSION;
const ELIGIBILITY_POLICY_VERSION = EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION;
const VALIDATOR_VERSION = EMAIL_LUNA_DRAFT_VALIDATOR_VERSION;
const STORE_DEPENDENCY_KEYS = objectFreeze(['withTransactionClient']);
const PERSIST_KEYS = objectFreeze(['operation_id', 'audit_operation_id', 'envelope', 'evidence', 'decision', 'eligibility', 'draft', 'validation']);
const LOAD_KEYS = objectFreeze(['operation_id', 'issuance_id']);
const PLAN_KEYS = objectFreeze(['template_id', 'tone', 'question_key', 'acknowledgment_key']);
const MATERIAL_PUBLIC_KEYS = objectFreeze([
  'operation_id', 'issuance_id', 'audit_operation_id', 'client_id', 'location_id', 'location_key',
  'endpoint_id', 'conversation_id', 'inbound_event_id', 'recipient_address', 'draft_digest',
  'language', 'identity', 'intent', 'intent_support', 'requested_location_id',
  'explicit_human_request', 'attachment_interpretation_required', 'unsafe_transactional_request',
  'required_facts', 'grounded_facts', 'template_id', 'tone', 'question_key', 'acknowledgment_key',
  'queue_state',
]);
const LOAD_ROW_KEYS = objectFreeze([
  ...MATERIAL_PUBLIC_KEYS,
  'envelope_subject', 'envelope_body_text', 'envelope_from_address', 'envelope_from_display_name',
]);
const PAYLOAD_KEYS = objectFreeze([
  'language', 'identity', 'intent', 'intent_support', 'requested_location_id',
  'explicit_human_request', 'attachment_interpretation_required', 'unsafe_transactional_request',
  'required_facts', 'grounded_facts', 'template_id', 'tone', 'question_key', 'acknowledgment_key',
]);
const FACT_FIELD_KEYS = objectFreeze({
  catalog: objectFreeze(['fact', 'status', 'client_id', 'location_id', 'item', 'label', 'currency', 'amount_cents', 'active']),
  availability: objectFreeze(['fact', 'status', 'client_id', 'location_id', 'item', 'label', 'date', 'slot_time', 'available', 'capacity']),
  policy: objectFreeze(['fact', 'status', 'client_id', 'location_id', 'label', 'policy_key']),
  booking: objectFreeze(['fact', 'status', 'client_id', 'location_id', 'booking_code', 'booking_status', 'label']),
  payment: objectFreeze(['fact', 'status', 'client_id', 'location_id', 'currency', 'payment_status', 'amount_paid_cents', 'balance_due_cents', 'label']),
});
const FACT_REQUIRED_KEYS = objectFreeze({
  catalog: objectFreeze(['fact', 'status', 'client_id', 'location_id', 'item', 'label', 'currency', 'amount_cents', 'active']),
  availability: objectFreeze(['fact', 'status', 'client_id', 'location_id', 'item', 'label', 'date', 'slot_time', 'available', 'capacity']),
  policy: objectFreeze(['fact', 'status', 'client_id', 'location_id', 'label', 'policy_key']),
  booking: objectFreeze(['fact', 'status', 'client_id', 'location_id', 'booking_code', 'booking_status']),
  payment: objectFreeze(['fact', 'status', 'client_id', 'location_id', 'currency', 'payment_status', 'amount_paid_cents', 'balance_due_cents']),
});
const INTENT_FACTS = objectFreeze({
  catalog_question: 'catalog',
  availability_question: 'availability',
  policy_question: 'policy',
  booking_status_question: 'booking',
  payment_status_question: 'payment',
});
const INTENT_TEMPLATES = objectFreeze({
  catalog_question: 'catalog_reply',
  availability_question: 'availability_reply',
  policy_question: 'policy_reply',
  booking_status_question: 'booking_status_reply',
  payment_status_question: 'payment_status_reply',
});
const EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT = objectFreeze({
  table: 'tenant_email_luna_automation_issuance_material',
  trusted_schema: 'public',
  search_path: objectFreeze(['pg_catalog', 'public']),
  function_owner: 'table_owner',
  worker_table_privileges: objectFreeze([]),
  worker_table_denied: objectFreeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
  producer_table_privileges: objectFreeze([]),
  producer_table_denied: objectFreeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
  producer_execute_functions: objectFreeze([
    'tenant_email_luna_automation_persist_and_enqueue',
  ]),
  worker_execute_functions: objectFreeze([
    'tenant_email_luna_automation_issuance_material_load',
  ]),
  operator_execute_functions: objectFreeze([]),
  no_custom_guc: true,
  no_synthetic_runtime_role_in_migration: true,
  no_grant_in_089: true,
  no_create_role_in_089: true,
  apply_in: 'ch4_runtime_worker_and_operator_roles',
  worker_material_select: false,
  producer_material_select: false,
  producer_queue_select: false,
});
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCATION_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PUBLIC_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const SQL_PERSIST = `SELECT persist_status, operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id, recipient_address, draft_digest, state, attempt_count, lease_owner, handoff_id FROM public.tenant_email_luna_automation_persist_and_enqueue($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text, $7::uuid, $8::uuid, $9::uuid, $10::text, $11::text, $12::text, $13::text, $14::text, $15::jsonb)`;
const SQL_LOAD = `SELECT operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id, recipient_address, draft_digest, language, identity, intent, intent_support, requested_location_id, explicit_human_request, attachment_interpretation_required, unsafe_transactional_request, required_facts, grounded_facts, template_id, tone, question_key, acknowledgment_key, queue_state, envelope_subject, envelope_body_text, envelope_from_address, envelope_from_display_name FROM public.tenant_email_luna_automation_issuance_material_load($1::uuid, $2::uuid)`;

function invalid() {
  const error = new Error('Email Luna automation issuance material failed.');
  error.code = 'EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_INVALID';
  return error;
}

function freeze(value) {
  return objectFreeze(value);
}

function output(entries) {
  const value = objectCreate(null);
  for (let index = 0; index < entries.length; index += 1) {
    objectDefineProperty(value, entries[index][0], {
      value: entries[index][1], enumerable: true, writable: true, configurable: true,
    });
  }
  return freeze(value);
}

function safeOwnKeys(value) {
  try {
    return reflectOwnKeys(value);
  } catch (_) {
    throw invalid();
  }
}

function exactPlain(value, keys) {
  if (value === null || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)) throw invalid();
  try {
    if (objectGetPrototypeOf(value) !== Object.prototype) throw invalid();
    const ownKeys = safeOwnKeys(value);
    if (ownKeys.length !== keys.length) throw invalid();
    const snapshot = objectCreate(null);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!arrayIncludes(ownKeys, key)) throw invalid();
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || !descriptor.enumerable) throw invalid();
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (error && error.code === 'EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_INVALID') throw error;
    throw invalid();
  }
}

function parseUuidRequired(raw) {
  if (raw === null || raw === undefined) throw invalid();
  const text = typeof raw === 'string' ? raw : (typeof raw === 'object' && raw && typeof raw.toString === 'function' ? raw.toString() : null);
  if (typeof text !== 'string') throw invalid();
  const id = stringToLowerCase(text);
  if (!regexpTest(UUID_CANON, id) || stringTrim(text) !== text) throw invalid();
  return id;
}

function normalizeRecipient(raw) {
  if (typeof raw !== 'string') throw invalid();
  const address = stringToLowerCase(stringTrim(raw));
  if (!regexpTest(PUBLIC_ADDRESS_RE, address) || address.length < 3 || address.length > 320) throw invalid();
  return address;
}

function draftDigest(draft) {
  if (!cryptoCreateHash) throw invalid();
  if (draft === null || typeof draft !== 'object' || runtimeIsProxy(draft) || arrayIsArray(draft)) throw invalid();
  const subject = objectGetOwnPropertyDescriptor(draft, 'subject');
  const body = objectGetOwnPropertyDescriptor(draft, 'body');
  const language = objectGetOwnPropertyDescriptor(draft, 'language');
  if (!subject || !body || language === undefined || typeof subject.value !== 'string' || typeof body.value !== 'string' || typeof language.value !== 'string') throw invalid();
  const digest = cryptoCreateHash('sha256').update(subject.value).update('\0').update(body.value).update('\0').update(language.value).digest('hex');
  if (!regexpTest(DIGEST_RE, digest)) throw invalid();
  return digest;
}

function ownErrorCode(error) {
  try {
    if (error === null || typeof error !== 'object' || runtimeIsProxy(error)) return undefined;
    const descriptor = objectGetOwnPropertyDescriptor(error, 'code');
    return descriptor && objectHasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch (_) {
    return undefined;
  }
}

function queryRows(result) {
  if (result === null || typeof result !== 'object' || runtimeIsProxy(result) || arrayIsArray(result)) throw invalid();
  const descriptor = objectGetOwnPropertyDescriptor(result, 'rows');
  if (!descriptor || !objectHasOwn(descriptor, 'value') || !arrayIsArray(descriptor.value)) throw invalid();
  return descriptor.value;
}

function readField(source, key) {
  const descriptor = objectGetOwnPropertyDescriptor(source, key);
  return descriptor && objectHasOwn(descriptor, 'value') ? descriptor.value : source[key];
}

function copyFactSnapshot(source, fact) {
  if (source === null || typeof source !== 'object' || runtimeIsProxy(source) || arrayIsArray(source)) throw invalid();
  const allowed = FACT_FIELD_KEYS[fact];
  const required = FACT_REQUIRED_KEYS[fact];
  if (!allowed || !required) throw invalid();
  const snapshot = objectCreate(null);
  for (let index = 0; index < allowed.length; index += 1) {
    const key = allowed[index];
    if (!objectHasOwn(source, key)) continue;
    const descriptor = objectGetOwnPropertyDescriptor(source, key);
    const value = descriptor && objectHasOwn(descriptor, 'value') ? descriptor.value : source[key];
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw invalid();
    snapshot[key] = value;
  }
  for (let index = 0; index < required.length; index += 1) {
    if (!objectHasOwn(snapshot, required[index])) throw invalid();
  }
  if (snapshot.fact !== fact || snapshot.status !== 'found') throw invalid();
  return snapshot;
}

function snapshotGroundedFacts(evidence, requiredFacts) {
  const resultsDesc = objectGetOwnPropertyDescriptor(evidence, 'grounded_results');
  const results = resultsDesc && objectHasOwn(resultsDesc, 'value') ? resultsDesc.value : evidence.grounded_results;
  if (results === null || typeof results !== 'object' || runtimeIsProxy(results) || arrayIsArray(results)) throw invalid();
  const facts = objectCreate(null);
  for (let index = 0; index < requiredFacts.length; index += 1) {
    const fact = requiredFacts[index];
    const itemDesc = objectGetOwnPropertyDescriptor(results, fact);
    const item = itemDesc && objectHasOwn(itemDesc, 'value') ? itemDesc.value : results[fact];
    facts[fact] = copyFactSnapshot(item, fact);
  }
  const extra = safeOwnKeys(results);
  if (extra.length !== requiredFacts.length) throw invalid();
  return facts;
}

function requiredFactsOf(evidence, intent) {
  const expected = INTENT_FACTS[intent];
  if (typeof expected !== 'string') throw invalid();
  const desc = objectGetOwnPropertyDescriptor(evidence, 'required_facts');
  const raw = desc && objectHasOwn(desc, 'value') ? desc.value : evidence.required_facts;
  if (!arrayIsArray(raw) || raw.length !== 1 || raw[0] !== expected) throw invalid();
  return objectFreeze([expected]);
}

function materialPayload(input, record) {
  const evidence = input.evidence;
  const language = evidence.language;
  const intent = evidence.intent;
  if (language !== 'en' && language !== 'es') throw invalid();
  if (evidence.identity !== 'matched' || evidence.intent_support !== 'supported') throw invalid();
  if (evidence.explicit_human_request !== false || evidence.attachment_interpretation_required !== false
      || evidence.unsafe_transactional_request !== false) throw invalid();
  if (evidence.requested_location_id !== record.location_id) throw invalid();
  const requiredFacts = requiredFactsOf(evidence, intent);
  const grounded = snapshotGroundedFacts(evidence, requiredFacts);
  const plan = readEmailLunaDraftAuthorPlan(input.draft);
  if (plan.template_id !== INTENT_TEMPLATES[intent]) throw invalid();
  const payload = objectCreate(null);
  payload.language = language;
  payload.identity = 'matched';
  payload.intent = intent;
  payload.intent_support = 'supported';
  payload.requested_location_id = record.location_id;
  payload.explicit_human_request = false;
  payload.attachment_interpretation_required = false;
  payload.unsafe_transactional_request = false;
  payload.required_facts = requiredFacts.slice();
  payload.grounded_facts = grounded;
  payload.template_id = plan.template_id;
  payload.tone = plan.tone;
  payload.question_key = plan.question_key;
  payload.acknowledgment_key = plan.acknowledgment_key;
  const keys = objectKeys(payload);
  if (keys.length !== PAYLOAD_KEYS.length) throw invalid();
  const encoded = jsonStringify(payload);
  if (typeof encoded !== 'string' || encoded.length > 8192) throw invalid();
  return jsonParse(encoded);
}

function brandLoaded(row) {
  weakSetAdd(AUTHENTIC_LOADED_MATERIAL, row);
  return row;
}

function assertAuthenticLoadedMaterial(value) {
  if (value === null || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)) throw invalid();
  if (objectGetPrototypeOf(value) !== null) throw invalid();
  if (!weakSetHas(AUTHENTIC_LOADED_MATERIAL, value)) throw invalid();
  return value;
}

function publicQueue(source) {
  if (source === null || typeof source !== 'object' || runtimeIsProxy(source) || arrayIsArray(source)) throw invalid();
  return freeze({
    operation_id: parseUuidRequired(readField(source, 'operation_id')),
    issuance_id: parseUuidRequired(readField(source, 'issuance_id')),
    audit_operation_id: parseUuidRequired(readField(source, 'audit_operation_id')),
    client_id: parseUuidRequired(readField(source, 'client_id')),
    location_id: parseUuidRequired(readField(source, 'location_id')),
    location_key: readField(source, 'location_key'),
    endpoint_id: parseUuidRequired(readField(source, 'endpoint_id')),
    conversation_id: parseUuidRequired(readField(source, 'conversation_id')),
    inbound_event_id: parseUuidRequired(readField(source, 'inbound_event_id')),
    recipient_address: normalizeRecipient(readField(source, 'recipient_address')),
    draft_digest: readField(source, 'draft_digest'),
    state: readField(source, 'state'),
    attempt_count: readField(source, 'attempt_count'),
    lease_owner: readField(source, 'lease_owner') == null ? null : parseUuidRequired(readField(source, 'lease_owner')),
    handoff_id: readField(source, 'handoff_id') == null ? null : parseUuidRequired(readField(source, 'handoff_id')),
  });
}

function parseTextArray(raw) {
  if (arrayIsArray(raw)) {
    const copy = [];
    for (let index = 0; index < raw.length; index += 1) {
      if (typeof raw[index] !== 'string') throw invalid();
      arrayPush(copy, raw[index]);
    }
    return objectFreeze(copy);
  }
  throw invalid();
}

function publicLoaded(source) {
  if (source === null || typeof source !== 'object' || runtimeIsProxy(source) || arrayIsArray(source)) throw invalid();
  const row = objectCreate(null);
  row.operation_id = parseUuidRequired(readField(source, 'operation_id'));
  row.issuance_id = parseUuidRequired(readField(source, 'issuance_id'));
  row.audit_operation_id = parseUuidRequired(readField(source, 'audit_operation_id'));
  row.client_id = parseUuidRequired(readField(source, 'client_id'));
  row.location_id = parseUuidRequired(readField(source, 'location_id'));
  const locationKey = readField(source, 'location_key');
  if (typeof locationKey !== 'string' || !regexpTest(LOCATION_KEY_RE, locationKey)) throw invalid();
  row.location_key = locationKey;
  row.endpoint_id = parseUuidRequired(readField(source, 'endpoint_id'));
  row.conversation_id = parseUuidRequired(readField(source, 'conversation_id'));
  row.inbound_event_id = parseUuidRequired(readField(source, 'inbound_event_id'));
  row.recipient_address = normalizeRecipient(readField(source, 'recipient_address'));
  const digest = readField(source, 'draft_digest');
  if (typeof digest !== 'string' || !regexpTest(DIGEST_RE, digest)) throw invalid();
  row.draft_digest = digest;
  row.language = readField(source, 'language');
  row.identity = readField(source, 'identity');
  row.intent = readField(source, 'intent');
  row.intent_support = readField(source, 'intent_support');
  row.requested_location_id = parseUuidRequired(readField(source, 'requested_location_id'));
  row.explicit_human_request = readField(source, 'explicit_human_request') === true;
  row.attachment_interpretation_required = readField(source, 'attachment_interpretation_required') === true;
  row.unsafe_transactional_request = readField(source, 'unsafe_transactional_request') === true;
  row.required_facts = parseTextArray(readField(source, 'required_facts'));
  const grounded = readField(source, 'grounded_facts');
  if (grounded === null || typeof grounded !== 'object' || runtimeIsProxy(grounded) || arrayIsArray(grounded)) throw invalid();
  row.grounded_facts = copyFactSnapshot(
    (objectGetOwnPropertyDescriptor(grounded, row.required_facts[0])
      && objectGetOwnPropertyDescriptor(grounded, row.required_facts[0]).value) || grounded[row.required_facts[0]],
    row.required_facts[0],
  );
  const groundedWrap = objectCreate(null);
  groundedWrap[row.required_facts[0]] = row.grounded_facts;
  row.grounded_facts = groundedWrap;
  row.template_id = readField(source, 'template_id');
  row.tone = readField(source, 'tone');
  row.question_key = readField(source, 'question_key');
  row.acknowledgment_key = readField(source, 'acknowledgment_key');
  row.queue_state = readField(source, 'queue_state');
  const subject = readField(source, 'envelope_subject');
  const body = readField(source, 'envelope_body_text');
  const fromAddress = readField(source, 'envelope_from_address');
  const fromName = readField(source, 'envelope_from_display_name');
  if (typeof subject !== 'string' || typeof body !== 'string' || typeof fromAddress !== 'string' || typeof fromName !== 'string') throw invalid();
  if (subject.length > 998 || body.length > 64000 || fromName.length > 998) throw invalid();
  row.envelope_subject = subject;
  row.envelope_body_text = body;
  row.envelope_from_address = fromAddress;
  row.envelope_from_display_name = fromName;
  const frozen = freeze(row);
  return brandLoaded(frozen);
}

function rebuildEvidenceSnapshot(material) {
  const fact = material.required_facts[0];
  const stored = material.grounded_facts[fact];
  const found = objectCreate(null);
  const allowed = FACT_FIELD_KEYS[fact];
  for (let index = 0; index < allowed.length; index += 1) {
    const key = allowed[index];
    if (objectHasOwn(stored, key)) found[key] = stored[key];
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
  const evidence = {
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
  return evidence;
}

function buildPersistIdentity(input) {
  const request = exactPlain(input, PERSIST_KEYS);
  const operationId = parseUuidRequired(request.operation_id);
  let trusted;
  try {
    trusted = assertEmailLunaDraftPolicyIssuance({
      envelope: request.envelope,
      evidence: request.evidence,
      decision: request.decision,
    });
  } catch (_) {
    throw invalid();
  }
  if (trusted.status !== 'draft_ready') throw invalid();
  let eligibility;
  try {
    eligibility = assertEmailLunaAutonomousEligibilityOutput(request.eligibility);
  } catch (_) {
    throw invalid();
  }
  if (eligibility.status !== 'eligible') throw invalid();
  if (eligibility.client_id !== trusted.binding.client_id || eligibility.location_id !== trusted.binding.location_id
      || eligibility.conversation_id !== trusted.binding.conversation_id) throw invalid();
  let validation;
  try {
    validation = assertEmailLunaDraftValidation(request.validation);
  } catch (_) {
    throw invalid();
  }
  if (validation.status !== 'valid') throw invalid();
  try {
    recomputeEmailLunaDraftCanonicalFromAuthentic({
      envelope: request.envelope,
      evidence: request.evidence,
      decision: request.decision,
      draft: request.draft,
    });
  } catch (_) {
    throw invalid();
  }
  const issuanceId = readEmailLunaDraftPolicyIssuanceIdentity(request.evidence);
  if (readEmailLunaDraftPolicyIssuanceIdentity(request.decision) !== issuanceId) throw invalid();
  const locationKey = trusted.authority.location_key;
  if (typeof locationKey !== 'string' || !regexpTest(LOCATION_KEY_RE, locationKey) || locationKey.length > 64) throw invalid();
  const record = objectCreate(null);
  record.operation_id = operationId;
  record.audit_operation_id = parseUuidRequired(request.audit_operation_id);
  record.issuance_id = issuanceId;
  record.client_id = trusted.binding.client_id;
  record.location_id = trusted.binding.location_id;
  record.location_key = locationKey;
  record.endpoint_id = trusted.authority.endpoint_id;
  record.conversation_id = trusted.binding.conversation_id;
  record.inbound_event_id = parseUuidRequired(trusted.authority.inbound_message_id);
  record.recipient_address = normalizeRecipient(trusted.untrusted_content.from_address);
  record.policy_version = DRAFT_POLICY_VERSION;
  record.eligibility_policy_version = ELIGIBILITY_POLICY_VERSION;
  record.validator_version = VALIDATOR_VERSION;
  record.draft_digest = draftDigest(request.draft);
  record.payload = materialPayload(request, record);
  return record;
}

function persistParams(record) {
  return [
    record.operation_id,
    record.issuance_id,
    record.audit_operation_id,
    record.client_id,
    record.location_id,
    record.location_key,
    record.endpoint_id,
    record.conversation_id,
    record.inbound_event_id,
    record.recipient_address,
    record.policy_version,
    record.eligibility_policy_version,
    record.validator_version,
    record.draft_digest,
    record.payload,
  ];
}

function recoverFromLoaded(material, recoverIssueAndDecideEmailLunaDraftPolicy) {
  if (typeof recoverIssueAndDecideEmailLunaDraftPolicy !== 'function' || runtimeIsProxy(recoverIssueAndDecideEmailLunaDraftPolicy)) {
    throw invalid();
  }
  assertAuthenticLoadedMaterial(material);
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
    evidence: rebuildEvidenceSnapshot(material),
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
  const digest = draftDigest(draft);
  if (digest !== material.draft_digest) throw invalid();
  const validation = validateEmailLunaDraft({
    envelope,
    evidence: issued.evidence,
    decision: issued.decision,
    draft,
  });
  if (validation.status !== 'valid') throw invalid();
  return freeze({
    envelope,
    evidence: issued.evidence,
    decision: issued.decision,
    draft,
    validation,
    issuance_id: material.issuance_id,
    draft_digest: digest,
    operation_id: material.operation_id,
  });
}

function createEmailLunaAutomationIssuanceMaterialStoreInternal(dependencies, recoverIssueAndDecideEmailLunaDraftPolicy) {
  if (typeof recoverIssueAndDecideEmailLunaDraftPolicy !== 'function' || runtimeIsProxy(recoverIssueAndDecideEmailLunaDraftPolicy)) {
    throw invalid();
  }
  const deps = exactPlain(dependencies, STORE_DEPENDENCY_KEYS);
  const withTransactionClient = deps.withTransactionClient;
  if (typeof withTransactionClient !== 'function' || runtimeIsProxy(withTransactionClient)) throw invalid();

  function persistAndEnqueueAutomationIssuance(input) {
    const record = buildPersistIdentity(input);
    return Promise.resolve(withTransactionClient(async (client) => {
      if (!client || typeof client !== 'object' || runtimeIsProxy(client) || typeof client.query !== 'function') throw invalid();
      let inserted;
      try {
        inserted = queryRows(await Promise.resolve(client.query(SQL_PERSIST, persistParams(record))));
      } catch (error) {
        if (ownErrorCode(error) === '23505') return output([['status', 'conflict']]);
        if (ownErrorCode(error) === '23514') return output([['status', 'conflict']]);
        throw invalid();
      }
      if (inserted.length !== 1) throw invalid();
      const current = inserted[0];
      const persistStatus = readField(current, 'persist_status');
      if (persistStatus !== 'committed' && persistStatus !== 'replayed') throw invalid();
      if (parseUuidRequired(readField(current, 'operation_id')) !== record.operation_id
          || parseUuidRequired(readField(current, 'issuance_id')) !== record.issuance_id
          || parseUuidRequired(readField(current, 'audit_operation_id')) !== record.audit_operation_id
          || readField(current, 'draft_digest') !== record.draft_digest) {
        throw invalid();
      }
      return output([['status', persistStatus], ['record', publicQueue(current)]]);
    }));
  }

  function loadAutomationIssuanceMaterial(input) {
    const request = exactPlain(input, LOAD_KEYS);
    const operationId = parseUuidRequired(request.operation_id);
    const issuanceId = parseUuidRequired(request.issuance_id);
    return Promise.resolve(withTransactionClient(async (client) => {
      if (!client || typeof client !== 'object' || runtimeIsProxy(client) || typeof client.query !== 'function') throw invalid();
      const rows = queryRows(await Promise.resolve(client.query(SQL_LOAD, [operationId, issuanceId])));
      if (rows.length !== 1) return output([['status', 'empty']]);
      return output([['status', 'loaded'], ['record', publicLoaded(rows[0])]]);
    }));
  }

  function recoverAutomationIssuance(input) {
    const request = exactPlain(input, ['material']);
    try {
      const recovered = recoverFromLoaded(request.material, recoverIssueAndDecideEmailLunaDraftPolicy);
      return output([['status', 'recovered'], ['record', recovered]]);
    } catch (error) {
      if (error && error.code === 'EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_INVALID') throw error;
      throw invalid();
    }
  }

  return freeze({
    persistAndEnqueueAutomationIssuance,
    loadAutomationIssuanceMaterial,
    recoverAutomationIssuance,
  });
}

function createEmailLunaAutomationIssuanceMaterialStore(dependencies) {
  if (arguments.length !== 1) throw invalid();
  const policy = require('./email-luna-draft-policy');
  if (typeof policy.createEmailLunaAutomationIssuanceMaterialStore !== 'function') throw invalid();
  return policy.createEmailLunaAutomationIssuanceMaterialStore(dependencies);
}

const policyModulePath = require.resolve('./email-luna-draft-policy');
const policyModuleNode = require.cache[policyModulePath];
if (!policyModuleNode || typeof policyModuleNode.installIssuanceMaterialStoreFactory !== 'function') {
  throw invalid();
}
policyModuleNode.installIssuanceMaterialStoreFactory(createEmailLunaAutomationIssuanceMaterialStoreInternal);
delete policyModuleNode.installIssuanceMaterialStoreFactory;

module.exports = {
  createEmailLunaAutomationIssuanceMaterialStore,
  EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_LOGGING_FORBIDDEN,
  EMAIL_LUNA_AUTOMATION_ISSUANCE_MATERIAL_GRANT_CONTRACT,
  MATERIAL_PUBLIC_KEYS,
  LOAD_ROW_KEYS,
};
