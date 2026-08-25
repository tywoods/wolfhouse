'use strict';

/**
 * FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B4: durable Luna-side shadow
 * comparison outcome owner.
 *
 * Persists append-only would_send / pending_human evidence and terminals the
 * 086 queue as shadow_captured through one SECURITY DEFINER CAS. Later-match
 * against 070 is read-time only. Default-off. Send-inert. Not a journal.
 */

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);

const arrayIncludes = uncurryThis(Array.prototype.includes);
const arraySome = uncurryThis(Array.prototype.some);
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectIsFrozen = Object.isFrozen;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const objectPrototype = Object.prototype;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const regexpTest = uncurryThis(RegExp.prototype.test);
const stringTrim = uncurryThis(String.prototype.trim);
const stringToLowerCase = uncurryThis(String.prototype.toLowerCase);
const weakSetAdd = uncurryThis(WeakSet.prototype.add);
const weakSetHas = uncurryThis(WeakSet.prototype.has);

const AUTHENTIC_SHADOW_OUTCOMES = new WeakSet();
const AUTHENTIC_STAFF_PROJECTIONS = new WeakSet();
const EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RUNTIME_WIRED = false;
const EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_LOGGING_FORBIDDEN = true;
const SHADOW_MODE = 'shadow';
const STORE_DEPENDENCY_KEYS = objectFreeze(['withTransactionClient']);
const CAPTURE_KEYS = objectFreeze(['operation_id', 'owner_token']);
const LOAD_KEYS = objectFreeze(['operation_id', 'issuance_id']);
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const LOCATION_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_STATES = objectFreeze([
  'pending_human', 'staff_action_observed', 'disagreement', 'excluded', 'invalid',
]);
const EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RECORD_KEYS = objectFreeze([
  'operation_id',
  'issuance_id',
  'audit_operation_id',
  'claim_lease_owner',
  'client_id',
  'location_id',
  'location_key',
  'endpoint_id',
  'conversation_id',
  'inbound_event_id',
  'recipient_digest',
  'policy_version',
  'eligibility_policy_version',
  'validator_version',
  'luna_decision',
  'comparison_state',
  'queue_state',
  'attempt_count',
]);
const STAFF_PROJECTION_KEYS = objectFreeze([
  'luna_decision',
  'comparison_state',
  'policy_version',
  'eligibility_policy_version',
  'validator_version',
  'queue_state',
  'human_bound',
  'duplicate_human',
  'mode',
  'draft_only',
  'requires_staff_review',
  'send_allowed',
  'auto_send_allowed',
  'provider_invoked',
  'journal_handoff',
  'provider_transition',
]);
const EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH = objectFreeze({
  human_owner: 'tenant_email_reply_approvals',
  human_identity: 'approval_id',
  match_keys: objectFreeze([
    'client_id',
    'location_id',
    'endpoint_id',
    'conversation_id',
    'inbound_event_id=source_inbound_event_id',
  ]),
  human_would_send_states: objectFreeze(['approved', 'terminal']),
  human_would_not_send_states: objectFreeze([]),
  infer_from_absence: false,
  model_based: false,
  luna_outbound_approvals: 'not_an_owner',
  disagreement_grounded: false,
  duplicate_human: 'excluded',
  rebound_human: 'invalid',
  no_human: 'pending_human',
  unique_human_would_send: 'staff_action_observed',
  unique_human_kind: 'inbound_workflow_identity',
  proves_provider_sent: false,
  proves_same_luna_draft: false,
  proves_same_recipient: false,
  proves_content_agreement: false,
  unsafe_labels: objectFreeze([
    'agreement',
    'staff sent Luna\'s mail',
    'same draft',
    'content agreement',
  ]),
});
const EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_GRANT_CONTRACT = objectFreeze({
  table: 'tenant_email_luna_automation_shadow_outcomes',
  trusted_schema: 'public',
  search_path: objectFreeze(['pg_catalog', 'public']),
  function_owner: 'table_owner',
  worker_table_privileges: objectFreeze([]),
  worker_table_denied: objectFreeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
  producer_table_privileges: objectFreeze([]),
  producer_table_denied: objectFreeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
  producer_execute_functions: objectFreeze([]),
  worker_execute_functions: objectFreeze([
    'tenant_email_luna_automation_capture_shadow',
    'tenant_email_luna_automation_shadow_outcome_load',
    'tenant_email_luna_automation_shadow_outcome_project',
  ]),
  operator_execute_functions: objectFreeze([]),
  no_custom_guc: true,
  no_synthetic_runtime_role_in_migration: true,
  no_grant_in_093: true,
  no_create_role_in_093: true,
  no_grant_in_094: true,
  no_create_role_in_094: true,
  no_grant_in_095: true,
  no_create_role_in_095: true,
  apply_in: 'ch4_runtime_worker_and_operator_roles',
  worker_shadow_outcome_select: false,
  producer_shadow_outcome_select: false,
});
const FORBIDDEN_INPUT_KEYS = objectFreeze([
  'status', 'would_send', 'would_not_send', 'send', 'provider', 'callback', 'onSend',
  'authorize_dispatch', 'authorize_create', 'authorize_update', 'claim', 'handoff',
  'client_id', 'location_id', 'recipient_address', 'recipient', 'capability',
  'facts', 'tenant', 'mode', 'send_allowed', 'auto_send_allowed', 'provider_invoked',
  'luna_decision', 'comparison_state', 'human_outcome', 'human_action_id',
  'agreement', 'staff_action_observed', 'disagreement', 'reason', 'policy_version', 'eligibility_policy_version',
  'validator_version', 'conversation_id', 'inbound_event_id',
  'endpoint_id', 'recipient_digest',
]);
const SQL_CAPTURE = 'SELECT persist_status, operation_id, issuance_id, audit_operation_id, claim_lease_owner, client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id, recipient_digest, policy_version, eligibility_policy_version, validator_version, luna_decision, comparison_state, queue_state, attempt_count FROM public.tenant_email_luna_automation_capture_shadow($1::uuid, $2::uuid)';
const SQL_LOAD = 'SELECT operation_id, issuance_id, audit_operation_id, claim_lease_owner, client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id, recipient_digest, policy_version, eligibility_policy_version, validator_version, luna_decision, comparison_state, queue_state, attempt_count FROM public.tenant_email_luna_automation_shadow_outcome_load($1::uuid, $2::uuid)';
const SQL_PROJECT = 'SELECT luna_decision, comparison_state, policy_version, eligibility_policy_version, validator_version, queue_state, human_bound, duplicate_human FROM public.tenant_email_luna_automation_shadow_outcome_project($1::uuid, $2::uuid)';

function invalid() {
  const error = new Error('Email Luna automation shadow outcome failed.');
  error.code = 'EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_INVALID';
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

function authenticOutcome(entries) {
  const frozen = output(entries);
  weakSetAdd(AUTHENTIC_SHADOW_OUTCOMES, frozen);
  return frozen;
}

function authenticStaff(entries) {
  const frozen = output(entries);
  weakSetAdd(AUTHENTIC_STAFF_PROJECTIONS, frozen);
  return frozen;
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
    if (objectGetPrototypeOf(value) !== objectPrototype) throw invalid();
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
    if (error && error.code === 'EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_INVALID') throw error;
    throw invalid();
  }
}

function refuseForbiddenKeys(value) {
  const ownKeys = safeOwnKeys(value);
  for (let index = 0; index < ownKeys.length; index += 1) {
    if (arrayIncludes(FORBIDDEN_INPUT_KEYS, ownKeys[index])) throw invalid();
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

function parseCount(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 3) return raw;
  if (typeof raw === 'string' && regexpTest(/^[0-3]$/, raw)) return Number(raw);
  throw invalid();
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

function publicRecord(source) {
  if (source === null || typeof source !== 'object' || runtimeIsProxy(source) || arrayIsArray(source)) throw invalid();
  const record = objectCreate(null);
  for (let index = 0; index < EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RECORD_KEYS.length; index += 1) {
    const key = EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RECORD_KEYS[index];
    const value = readField(source, key);
    if (key === 'attempt_count') record[key] = parseCount(value);
    else if (key === 'recipient_digest') {
      if (typeof value !== 'string' || !regexpTest(DIGEST_RE, value)) throw invalid();
      record[key] = value;
    } else if (key === 'location_key') {
      if (typeof value !== 'string' || !regexpTest(LOCATION_KEY_RE, value) || value.length > 64) throw invalid();
      record[key] = value;
    } else if (key === 'luna_decision') {
      if (value !== 'would_send') throw invalid();
      record[key] = value;
    } else if (key === 'comparison_state') {
      if (value !== 'pending_human') throw invalid();
      record[key] = value;
    } else if (key === 'queue_state') {
      if (value !== 'shadow_captured') throw invalid();
      record[key] = value;
    } else if (key === 'policy_version') {
      if (value !== 'email-luna-draft-policy.v1') throw invalid();
      record[key] = value;
    } else if (key === 'eligibility_policy_version') {
      if (value !== 'email-luna-autonomous-eligibility-policy.v1') throw invalid();
      record[key] = value;
    } else if (key === 'validator_version') {
      if (value !== 'email-luna-draft-validator.v1') throw invalid();
      record[key] = value;
    } else record[key] = parseUuidRequired(value);
  }
  return authenticOutcome(EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RECORD_KEYS.map((key) => [key, record[key]]));
}

function staffRecord(source) {
  if (source === null || typeof source !== 'object' || runtimeIsProxy(source) || arrayIsArray(source)) throw invalid();
  const lunaDecision = readField(source, 'luna_decision');
  const comparisonState = readField(source, 'comparison_state');
  const humanBound = readField(source, 'human_bound');
  const duplicateHuman = readField(source, 'duplicate_human');
  const queueState = readField(source, 'queue_state');
  if (lunaDecision !== 'would_send') throw invalid();
  if (!arrayIncludes(EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_STATES, comparisonState)) throw invalid();
  if (comparisonState === 'disagreement' || comparisonState === 'agreement') throw invalid();
  if (queueState !== 'shadow_captured') throw invalid();
  if (humanBound !== true && humanBound !== false) throw invalid();
  if (duplicateHuman !== true && duplicateHuman !== false) throw invalid();
  if (comparisonState === 'pending_human' && (humanBound !== false || duplicateHuman !== false)) throw invalid();
  if (comparisonState === 'staff_action_observed' && (humanBound !== true || duplicateHuman !== false)) throw invalid();
  if (comparisonState === 'excluded' && humanBound !== true) throw invalid();
  if (comparisonState === 'invalid' && (humanBound !== false || duplicateHuman !== false)) throw invalid();
  return authenticStaff([
    ['luna_decision', 'would_send'],
    ['comparison_state', comparisonState],
    ['policy_version', 'email-luna-draft-policy.v1'],
    ['eligibility_policy_version', 'email-luna-autonomous-eligibility-policy.v1'],
    ['validator_version', 'email-luna-draft-validator.v1'],
    ['queue_state', 'shadow_captured'],
    ['human_bound', humanBound],
    ['duplicate_human', duplicateHuman],
    ['mode', SHADOW_MODE],
    ['draft_only', true],
    ['requires_staff_review', true],
    ['send_allowed', false],
    ['auto_send_allowed', false],
    ['provider_invoked', false],
    ['journal_handoff', false],
    ['provider_transition', false],
  ]);
}

function assertEmailLunaAutomationShadowOutcome(value) {
  if (value === null || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)) throw invalid();
  if (!weakSetHas(AUTHENTIC_SHADOW_OUTCOMES, value) || !objectIsFrozen(value)) throw invalid();
  if (objectGetPrototypeOf(value) !== null) throw invalid();
  if (value.luna_decision !== 'would_send' || value.comparison_state !== 'pending_human') throw invalid();
  if (value.queue_state !== 'shadow_captured') throw invalid();
  return value;
}

function assertEmailLunaAutomationShadowComparisonProjection(value) {
  if (value === null || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)) throw invalid();
  if (!weakSetHas(AUTHENTIC_STAFF_PROJECTIONS, value) || !objectIsFrozen(value)) throw invalid();
  if (objectGetPrototypeOf(value) !== null) throw invalid();
  if (value.send_allowed !== false || value.auto_send_allowed !== false) throw invalid();
  if (value.provider_invoked !== false || value.mode !== SHADOW_MODE) throw invalid();
  if (value.journal_handoff !== false || value.provider_transition !== false) throw invalid();
  if (value.luna_decision !== 'would_send') throw invalid();
  if (value.comparison_state === 'disagreement' || value.comparison_state === 'agreement') throw invalid();
  const own = safeOwnKeys(value);
  if (own.length !== STAFF_PROJECTION_KEYS.length) throw invalid();
  for (let index = 0; index < STAFF_PROJECTION_KEYS.length; index += 1) {
    if (!arrayIncludes(own, STAFF_PROJECTION_KEYS[index])) throw invalid();
  }
  if (arraySome(own, (key) => arrayIncludes([
    'operation_id', 'issuance_id', 'client_id', 'location_id', 'conversation_id',
    'inbound_event_id', 'endpoint_id', 'claim_lease_owner', 'recipient_digest',
    'recipient_address', 'subject', 'body', 'message_text', 'human_action_id',
  ], key))) throw invalid();
  return value;
}

function createEmailLunaAutomationShadowOutcomeStore(dependencies) {
  if (arguments.length !== 1) throw invalid();
  refuseForbiddenKeys(dependencies);
  const deps = exactPlain(dependencies, STORE_DEPENDENCY_KEYS);
  const withTransactionClient = deps.withTransactionClient;
  if (typeof withTransactionClient !== 'function' || runtimeIsProxy(withTransactionClient)) throw invalid();

  function captureShadowOutcome(input) {
    if (arguments.length !== 1) throw invalid();
    refuseForbiddenKeys(input);
    const request = exactPlain(input, CAPTURE_KEYS);
    const operationId = parseUuidRequired(request.operation_id);
    const owner = parseUuidRequired(request.owner_token);
    return Promise.resolve(withTransactionClient(async (client) => {
      if (!client || typeof client !== 'object' || runtimeIsProxy(client) || typeof client.query !== 'function') throw invalid();
      let rows;
      try {
        rows = queryRows(await Promise.resolve(client.query(SQL_CAPTURE, [operationId, owner])));
      } catch (error) {
        if (ownErrorCode(error) === '23514') return output([['status', 'conflict']]);
        throw invalid();
      }
      if (rows.length === 0) return output([['status', 'conflict']]);
      if (rows.length !== 1) throw invalid();
      const persistStatus = readField(rows[0], 'persist_status');
      if (persistStatus !== 'committed' && persistStatus !== 'replayed') throw invalid();
      return output([['status', persistStatus], ['record', publicRecord(rows[0])]]);
    }));
  }

  function loadShadowOutcome(input) {
    if (arguments.length !== 1) throw invalid();
    refuseForbiddenKeys(input);
    const request = exactPlain(input, LOAD_KEYS);
    const operationId = parseUuidRequired(request.operation_id);
    const issuanceId = parseUuidRequired(request.issuance_id);
    return Promise.resolve(withTransactionClient(async (client) => {
      if (!client || typeof client !== 'object' || runtimeIsProxy(client) || typeof client.query !== 'function') throw invalid();
      let rows;
      try {
        rows = queryRows(await Promise.resolve(client.query(SQL_LOAD, [operationId, issuanceId])));
      } catch (_) {
        throw invalid();
      }
      if (rows.length === 0) return output([['status', 'missing']]);
      if (rows.length !== 1) throw invalid();
      return output([['status', 'loaded'], ['record', publicRecord(rows[0])]]);
    }));
  }

  function projectStaffSafeShadowComparison(input) {
    if (arguments.length !== 1) throw invalid();
    refuseForbiddenKeys(input);
    const request = exactPlain(input, LOAD_KEYS);
    const operationId = parseUuidRequired(request.operation_id);
    const issuanceId = parseUuidRequired(request.issuance_id);
    return Promise.resolve(withTransactionClient(async (client) => {
      if (!client || typeof client !== 'object' || runtimeIsProxy(client) || typeof client.query !== 'function') throw invalid();
      let rows;
      try {
        rows = queryRows(await Promise.resolve(client.query(SQL_PROJECT, [operationId, issuanceId])));
      } catch (_) {
        throw invalid();
      }
      if (rows.length === 0) return output([['status', 'missing']]);
      if (rows.length !== 1) throw invalid();
      return output([['status', 'projected'], ['record', staffRecord(rows[0])]]);
    }));
  }

  return freeze({
    captureShadowOutcome,
    loadShadowOutcome,
    projectStaffSafeShadowComparison,
  });
}

module.exports = objectFreeze({
  createEmailLunaAutomationShadowOutcomeStore,
  assertEmailLunaAutomationShadowOutcome,
  assertEmailLunaAutomationShadowComparisonProjection,
  EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_LOGGING_FORBIDDEN,
  EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_GRANT_CONTRACT,
  EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_RECORD_KEYS,
  EMAIL_LUNA_AUTOMATION_SHADOW_OUTCOME_STATES,
  EMAIL_LUNA_AUTOMATION_SHADOW_COMPARISON_LATER_MATCH,
  STAFF_PROJECTION_KEYS,
  SHADOW_MODE,
});
