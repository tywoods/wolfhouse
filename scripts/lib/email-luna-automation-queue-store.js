'use strict';

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);
const nodeCrypto = require('node:crypto');
const { assertEmailLunaDraftPolicyIssuance, readEmailLunaDraftPolicyIssuanceIdentity, EMAIL_LUNA_DRAFT_POLICY_VERSION } = require('./email-luna-draft-policy');
const {
  assertEmailLunaAutonomousEligibilityOutput,
  EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION,
} = require('./email-luna-autonomous-eligibility-policy');
const { recomputeEmailLunaDraftCanonicalFromAuthentic } = require('./email-luna-draft-author');
const {
  assertEmailLunaDraftValidation,
  EMAIL_LUNA_DRAFT_VALIDATOR_VERSION,
} = require('./email-luna-draft-validator');

const arrayIncludes = uncurryThis(Array.prototype.includes);
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const regexpTest = uncurryThis(RegExp.prototype.test);
const stringTrim = uncurryThis(String.prototype.trim);
const stringToLowerCase = uncurryThis(String.prototype.toLowerCase);
const cryptoCreateHash = typeof nodeCrypto.createHash === 'function' ? nodeCrypto.createHash.bind(nodeCrypto) : null;

const EMAIL_LUNA_AUTOMATION_QUEUE_RUNTIME_WIRED = false;
const EMAIL_LUNA_AUTOMATION_QUEUE_LOGGING_FORBIDDEN = true;
const EMAIL_LUNA_AUTOMATION_QUEUE_MAX_ATTEMPTS = 3;
const DRAFT_POLICY_VERSION = EMAIL_LUNA_DRAFT_POLICY_VERSION;
const ELIGIBILITY_POLICY_VERSION = EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION;
const VALIDATOR_VERSION = EMAIL_LUNA_DRAFT_VALIDATOR_VERSION;
const STORE_DEPENDENCY_KEYS = objectFreeze(['withTransactionClient']);
const ENQUEUE_KEYS = objectFreeze(['operation_id', 'envelope', 'evidence', 'decision', 'eligibility', 'draft', 'validation']);
const CLAIM_KEYS = objectFreeze(['owner_token', 'operation_id']);
const CLAIM_NEXT_KEYS = objectFreeze(['owner_token']);
const OP_OWNER_KEYS = objectFreeze(['operation_id', 'owner_token']);
const EMAIL_LUNA_AUTOMATION_QUEUE_STATES = objectFreeze([
  'pending', 'claimed', 'handed_off', 'handoff_required', 'cancelled',
]);
const EMAIL_LUNA_AUTOMATION_QUEUE_RECORD_KEYS = objectFreeze([
  'operation_id',
  'issuance_id',
  'audit_operation_id',
  'client_id',
  'location_id',
  'location_key',
  'endpoint_id',
  'conversation_id',
  'inbound_event_id',
  'recipient_address',
  'policy_version',
  'eligibility_policy_version',
  'validator_version',
  'draft_digest',
  'state',
  'attempt_count',
  'lease_owner',
  'handoff_id',
]);
const EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT = objectFreeze({
  table: 'tenant_email_luna_automation_queue',
  trusted_schema: 'public',
  search_path: objectFreeze(['pg_catalog', 'public']),
  function_owner: 'table_owner',
  worker_table_privileges: objectFreeze(['SELECT']),
  worker_table_denied: objectFreeze(['INSERT', 'UPDATE', 'DELETE']),
  worker_execute_functions: objectFreeze([
    'tenant_email_luna_automation_enqueue',
    'tenant_email_luna_automation_claim',
    'tenant_email_luna_automation_cancel_claimed',
    'tenant_email_luna_automation_require_handoff_claimed',
    'tenant_email_luna_automation_handoff',
    'tenant_email_luna_automation_terminalize_attempt_cap',
  ]),
  operator_execute_functions: objectFreeze([
    'tenant_email_luna_automation_cancel_pending',
    'tenant_email_luna_automation_require_handoff_pending',
  ]),
  no_custom_guc: true,
  no_synthetic_runtime_role_in_migration: true,
  no_grant_in_086: true,
  apply_in: 'ch4_runtime_worker_and_operator_roles',
});
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCATION_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PUBLIC_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const COLUMNS = EMAIL_LUNA_AUTOMATION_QUEUE_RECORD_KEYS.join(', ');
const SQL_LOCK_OPERATION = `SELECT ${COLUMNS} FROM tenant_email_luna_automation_queue WHERE operation_id = $1::uuid FOR SHARE`;
const SQL_LOCK_ISSUANCE = `SELECT ${COLUMNS} FROM tenant_email_luna_automation_queue WHERE issuance_id = $1::uuid FOR SHARE`;
const SQL_LOCK_AUDIT = `SELECT operation_id, issuance_id, client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id FROM tenant_email_luna_policy_audit WHERE issuance_id = $1::uuid FOR SHARE`;
const SQL_ENQUEUE = `SELECT ${COLUMNS} FROM tenant_email_luna_automation_enqueue($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::text, $7::uuid, $8::uuid, $9::uuid, $10::text, $11::text, $12::text, $13::text, $14::text)`;
const SQL_CLAIM = `SELECT ${COLUMNS} FROM tenant_email_luna_automation_claim($1::uuid, $2::uuid)`;
const SQL_ATTEMPT_CAP = `SELECT ${COLUMNS} FROM tenant_email_luna_automation_terminalize_attempt_cap($1::uuid, $2::uuid)`;
const SQL_HANDOFF = `SELECT ${COLUMNS} FROM tenant_email_luna_automation_handoff($1::uuid, $2::uuid)`;
const SQL_CANCEL_CLAIMED = `SELECT ${COLUMNS} FROM tenant_email_luna_automation_cancel_claimed($1::uuid, $2::uuid)`;
const SQL_REQUIRE_HANDOFF_CLAIMED = `SELECT ${COLUMNS} FROM tenant_email_luna_automation_require_handoff_claimed($1::uuid, $2::uuid)`;

function invalid() {
  const error = new Error('Email Luna automation queue failed.');
  error.code = 'EMAIL_LUNA_AUTOMATION_QUEUE_INVALID';
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
    if (error && error.code === 'EMAIL_LUNA_AUTOMATION_QUEUE_INVALID') throw error;
    throw invalid();
  }
}

function parseUuid(raw) {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === 'string' ? raw : (typeof raw === 'object' && raw && typeof raw.toString === 'function' ? raw.toString() : null);
  if (typeof text !== 'string') throw invalid();
  const id = stringToLowerCase(text);
  if (!regexpTest(UUID_CANON, id) || stringTrim(text) !== text) throw invalid();
  return id;
}

function parseUuidRequired(raw) {
  const id = parseUuid(raw);
  if (id === null) throw invalid();
  return id;
}

function parseCount(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= EMAIL_LUNA_AUTOMATION_QUEUE_MAX_ATTEMPTS) return raw;
  if (typeof raw === 'string' && regexpTest(/^[0-3]$/, raw)) return Number(raw);
  throw invalid();
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
  if (!subject || !body || !language || typeof subject.value !== 'string' || typeof body.value !== 'string' || typeof language.value !== 'string') throw invalid();
  const digest = cryptoCreateHash('sha256').update(subject.value).update('\0').update(body.value).update('\0').update(language.value).digest('hex');
  if (!regexpTest(DIGEST_RE, digest)) throw invalid();
  return digest;
}

function publicRecord(source) {
  const record = objectCreate(null);
  for (let index = 0; index < EMAIL_LUNA_AUTOMATION_QUEUE_RECORD_KEYS.length; index += 1) {
    const key = EMAIL_LUNA_AUTOMATION_QUEUE_RECORD_KEYS[index];
    const descriptor = objectGetOwnPropertyDescriptor(source, key);
    const value = descriptor && objectHasOwn(descriptor, 'value') ? descriptor.value : source[key];
    if (key === 'attempt_count') record[key] = parseCount(value);
    else if (key === 'lease_owner' || key === 'handoff_id') record[key] = value === null || value === undefined ? null : parseUuidRequired(value);
    else if (key === 'state') {
      if (!arrayIncludes(EMAIL_LUNA_AUTOMATION_QUEUE_STATES, value)) throw invalid();
      record[key] = value;
    } else if (key === 'recipient_address') record[key] = normalizeRecipient(value);
    else if (key === 'draft_digest') {
      if (typeof value !== 'string' || !regexpTest(DIGEST_RE, value)) throw invalid();
      record[key] = value;
    } else if (key === 'location_key') {
      if (typeof value !== 'string' || !regexpTest(LOCATION_KEY_RE, value) || value.length > 64) throw invalid();
      record[key] = value;
    } else if (key === 'policy_version') {
      if (value !== DRAFT_POLICY_VERSION) throw invalid();
      record[key] = value;
    } else if (key === 'eligibility_policy_version') {
      if (value !== ELIGIBILITY_POLICY_VERSION) throw invalid();
      record[key] = value;
    } else if (key === 'validator_version') {
      if (value !== VALIDATOR_VERSION) throw invalid();
      record[key] = value;
    } else record[key] = parseUuidRequired(value);
  }
  return freeze(record);
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

function auditRow(source) {
  if (source === null || typeof source !== 'object' || runtimeIsProxy(source) || arrayIsArray(source)) throw invalid();
  const read = (key) => {
    const descriptor = objectGetOwnPropertyDescriptor(source, key);
    const value = descriptor && objectHasOwn(descriptor, 'value') ? descriptor.value : source[key];
    return value;
  };
  return {
    operation_id: parseUuidRequired(read('operation_id')),
    issuance_id: parseUuidRequired(read('issuance_id')),
    client_id: parseUuidRequired(read('client_id')),
    location_id: parseUuidRequired(read('location_id')),
    location_key: read('location_key'),
    endpoint_id: parseUuidRequired(read('endpoint_id')),
    conversation_id: parseUuidRequired(read('conversation_id')),
    inbound_event_id: parseUuidRequired(read('inbound_event_id')),
  };
}

function buildIdentity(input) {
  const request = exactPlain(input, ENQUEUE_KEYS);
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
  if (eligibility.draft_only !== true || eligibility.send_allowed !== false || eligibility.auto_send_allowed !== false) throw invalid();
  if (eligibility.grounded_facts !== request.decision.grounded_facts) throw invalid();
  let validation;
  try {
    validation = assertEmailLunaDraftValidation(request.validation);
  } catch (_) {
    throw invalid();
  }
  if (validation.status !== 'valid') throw invalid();
  if (validation.client_id !== trusted.binding.client_id || validation.location_id !== trusted.binding.location_id
      || validation.conversation_id !== trusted.binding.conversation_id) throw invalid();
  if (validation.send_allowed !== false || validation.auto_send_allowed !== false) throw invalid();
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
  const inboundEventId = parseUuidRequired(trusted.authority.inbound_message_id);
  const recipient = normalizeRecipient(trusted.untrusted_content.from_address);
  const digest = draftDigest(request.draft);
  const record = objectCreate(null);
  record.operation_id = operationId;
  record.issuance_id = issuanceId;
  record.client_id = trusted.binding.client_id;
  record.location_id = trusted.binding.location_id;
  record.location_key = locationKey;
  record.endpoint_id = trusted.authority.endpoint_id;
  record.conversation_id = trusted.binding.conversation_id;
  record.inbound_event_id = inboundEventId;
  record.recipient_address = recipient;
  record.policy_version = DRAFT_POLICY_VERSION;
  record.eligibility_policy_version = ELIGIBILITY_POLICY_VERSION;
  record.validator_version = VALIDATOR_VERSION;
  record.draft_digest = digest;
  record.state = 'pending';
  record.attempt_count = 0;
  record.lease_owner = null;
  record.handoff_id = null;
  return record;
}

function insertParams(record) {
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
  ];
}

function bindAudit(record, audit) {
  if (audit.issuance_id !== record.issuance_id) throw invalid();
  if (audit.client_id !== record.client_id || audit.location_id !== record.location_id
      || audit.location_key !== record.location_key || audit.endpoint_id !== record.endpoint_id
      || audit.conversation_id !== record.conversation_id
      || audit.inbound_event_id !== record.inbound_event_id) throw invalid();
  record.audit_operation_id = audit.operation_id;
}

function parseClaim(input) {
  try {
    const targeted = exactPlain(input, CLAIM_KEYS);
    return { owner_token: parseUuidRequired(targeted.owner_token), operation_id: parseUuidRequired(targeted.operation_id) };
  } catch (error) {
    if (error && error.code === 'EMAIL_LUNA_AUTOMATION_QUEUE_INVALID') {
      const next = exactPlain(input, CLAIM_NEXT_KEYS);
      return { owner_token: parseUuidRequired(next.owner_token), operation_id: null };
    }
    throw invalid();
  }
}

function createEmailLunaAutomationQueueStore(dependencies) {
  const deps = exactPlain(dependencies, STORE_DEPENDENCY_KEYS);
  const withTransactionClient = deps.withTransactionClient;
  if (typeof withTransactionClient !== 'function' || runtimeIsProxy(withTransactionClient)) throw invalid();

  function enqueueAutomationOperation(input) {
    const record = buildIdentity(input);
    return Promise.resolve(withTransactionClient(async (client) => {
      if (!client || typeof client !== 'object' || runtimeIsProxy(client) || typeof client.query !== 'function') throw invalid();
      const existingOp = queryRows(await Promise.resolve(client.query(SQL_LOCK_OPERATION, [record.operation_id])));
      if (existingOp.length > 1) throw invalid();
      if (existingOp.length === 1) {
        const current = publicRecord(existingOp[0]);
        const sameIdentity = current.issuance_id === record.issuance_id
          && current.client_id === record.client_id
          && current.location_id === record.location_id
          && current.location_key === record.location_key
          && current.endpoint_id === record.endpoint_id
          && current.conversation_id === record.conversation_id
          && current.inbound_event_id === record.inbound_event_id
          && current.recipient_address === record.recipient_address
          && current.policy_version === record.policy_version
          && current.eligibility_policy_version === record.eligibility_policy_version
          && current.validator_version === record.validator_version
          && current.draft_digest === record.draft_digest;
        if (sameIdentity) return output([['status', 'replayed'], ['record', current]]);
        return output([['status', 'conflict']]);
      }
      const audits = queryRows(await Promise.resolve(client.query(SQL_LOCK_AUDIT, [record.issuance_id])));
      if (audits.length !== 1) throw invalid();
      bindAudit(record, auditRow(audits[0]));
      const identity = publicRecord(record);
      const existingIssuance = queryRows(await Promise.resolve(client.query(SQL_LOCK_ISSUANCE, [identity.issuance_id])));
      if (existingIssuance.length > 1) throw invalid();
      if (existingIssuance.length === 1) return output([['status', 'conflict']]);
      let inserted;
      try {
        inserted = queryRows(await Promise.resolve(client.query(SQL_ENQUEUE, insertParams(identity))));
      } catch (error) {
        if (ownErrorCode(error) === '23505') return output([['status', 'conflict']]);
        throw invalid();
      }
      if (inserted.length !== 1) throw invalid();
      return output([['status', 'committed'], ['record', publicRecord(inserted[0])]]);
    }));
  }

  function claimAutomationOperation(input) {
    const request = parseClaim(input);
    return Promise.resolve(withTransactionClient(async (client) => {
      if (!client || typeof client !== 'object' || runtimeIsProxy(client) || typeof client.query !== 'function') throw invalid();
      const claimed = queryRows(await Promise.resolve(client.query(SQL_CLAIM, [request.owner_token, request.operation_id])));
      if (claimed.length === 1) return output([['status', 'claimed'], ['record', publicRecord(claimed[0])]]);
      if (request.operation_id) {
        const capped = queryRows(await Promise.resolve(client.query(SQL_ATTEMPT_CAP, [request.operation_id, request.owner_token])));
        if (capped.length === 1) return output([['status', 'attempt_cap'], ['record', publicRecord(capped[0])]]);
        const existing = queryRows(await Promise.resolve(client.query(SQL_LOCK_OPERATION, [request.operation_id])));
        if (existing.length === 1) return output([['status', 'conflict']]);
      }
      return output([['status', 'empty']]);
    }));
  }

  function handOffAutomationOperation(input) {
    const request = exactPlain(input, OP_OWNER_KEYS);
    const operationId = parseUuidRequired(request.operation_id);
    const owner = parseUuidRequired(request.owner_token);
    return Promise.resolve(withTransactionClient(async (client) => {
      if (!client || typeof client !== 'object' || runtimeIsProxy(client) || typeof client.query !== 'function') throw invalid();
      const rows = queryRows(await Promise.resolve(client.query(SQL_HANDOFF, [operationId, owner])));
      if (rows.length !== 1) return output([['status', 'conflict']]);
      return output([['status', 'handed_off'], ['record', publicRecord(rows[0])]]);
    }));
  }

  function cancelAutomationOperation(input) {
    const request = exactPlain(input, OP_OWNER_KEYS);
    const operationId = parseUuidRequired(request.operation_id);
    const owner = parseUuidRequired(request.owner_token);
    return Promise.resolve(withTransactionClient(async (client) => {
      if (!client || typeof client !== 'object' || runtimeIsProxy(client) || typeof client.query !== 'function') throw invalid();
      const claimed = queryRows(await Promise.resolve(client.query(SQL_CANCEL_CLAIMED, [operationId, owner])));
      if (claimed.length === 1) return output([['status', 'cancelled'], ['record', publicRecord(claimed[0])]]);
      return output([['status', 'conflict']]);
    }));
  }

  function requireHandoffAutomationOperation(input) {
    const request = exactPlain(input, OP_OWNER_KEYS);
    const operationId = parseUuidRequired(request.operation_id);
    const owner = parseUuidRequired(request.owner_token);
    return Promise.resolve(withTransactionClient(async (client) => {
      if (!client || typeof client !== 'object' || runtimeIsProxy(client) || typeof client.query !== 'function') throw invalid();
      const claimed = queryRows(await Promise.resolve(client.query(SQL_REQUIRE_HANDOFF_CLAIMED, [operationId, owner])));
      if (claimed.length === 1) return output([['status', 'handoff_required'], ['record', publicRecord(claimed[0])]]);
      return output([['status', 'conflict']]);
    }));
  }

  return freeze({
    enqueueAutomationOperation,
    claimAutomationOperation,
    handOffAutomationOperation,
    cancelAutomationOperation,
    requireHandoffAutomationOperation,
  });
}

module.exports = {
  createEmailLunaAutomationQueueStore,
  EMAIL_LUNA_AUTOMATION_QUEUE_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_QUEUE_LOGGING_FORBIDDEN,
  EMAIL_LUNA_AUTOMATION_QUEUE_RECORD_KEYS,
  EMAIL_LUNA_AUTOMATION_QUEUE_STATES,
  EMAIL_LUNA_AUTOMATION_QUEUE_MAX_ATTEMPTS,
  EMAIL_LUNA_AUTOMATION_QUEUE_GRANT_CONTRACT,
  SQL_LOCK_OPERATION,
  SQL_LOCK_ISSUANCE,
  SQL_LOCK_AUDIT,
  SQL_ENQUEUE,
  SQL_CLAIM,
  SQL_ATTEMPT_CAP,
  SQL_HANDOFF,
  SQL_CANCEL_CLAIMED,
  SQL_REQUIRE_HANDOFF_CLAIMED,
};
