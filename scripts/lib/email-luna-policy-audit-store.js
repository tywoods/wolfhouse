'use strict';

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);
const { assertEmailLunaDraftPolicyIssuance, readEmailLunaDraftPolicyIssuanceIdentity, EMAIL_LUNA_DRAFT_POLICY_VERSION } = require('./email-luna-draft-policy');
const {
  assertEmailLunaAutonomousEligibilityOutput,
  EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION,
  EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_HANDOFF_REASONS,
} = require('./email-luna-autonomous-eligibility-policy');

const arrayIncludes = uncurryThis(Array.prototype.includes);
const objectCreate = Object.create;
const objectDefineProperty = Object.defineProperty;
const objectFreeze = Object.freeze;
const objectIsFrozen = Object.isFrozen;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const regexpTest = uncurryThis(RegExp.prototype.test);

const EMAIL_LUNA_POLICY_AUDIT_RUNTIME_WIRED = false;
const EMAIL_LUNA_POLICY_AUDIT_LOGGING_FORBIDDEN = true;
const EMAIL_LUNA_POLICY_AUDIT_SCHEMA_085 = '085';
const EMAIL_LUNA_POLICY_AUDIT_SCHEMA_086 = '086';
const DRAFT_POLICY_VERSION = EMAIL_LUNA_DRAFT_POLICY_VERSION;
const ELIGIBILITY_POLICY_VERSION = EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION;
const ELIGIBILITY_REASONS = EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_HANDOFF_REASONS;
const STORE_DEPENDENCY_KEYS = objectFreeze(['withTransactionClient', 'schemaVersion']);
const INPUT_KEYS = objectFreeze(['operation_id', 'envelope', 'evidence', 'decision', 'eligibility']);
const EMAIL_LUNA_POLICY_AUDIT_RECORD_KEYS = objectFreeze([
  'operation_id',
  'issuance_id',
  'client_id',
  'location_id',
  'location_key',
  'endpoint_id',
  'conversation_id',
  'policy_version',
  'eligibility_policy_version',
  'canonical_status',
  'canonical_reason',
  'eligibility_status',
  'eligibility_reason',
  'fact_refs',
]);
const EMAIL_LUNA_POLICY_AUDIT_RECORD_KEYS_086 = objectFreeze([
  'operation_id',
  'issuance_id',
  'client_id',
  'location_id',
  'location_key',
  'endpoint_id',
  'conversation_id',
  'inbound_event_id',
  'policy_version',
  'eligibility_policy_version',
  'canonical_status',
  'canonical_reason',
  'eligibility_status',
  'eligibility_reason',
  'fact_refs',
]);
const FACTS = objectFreeze(['catalog', 'availability', 'policy', 'booking', 'payment']);
const CANONICAL_STATUSES = objectFreeze(['draft_ready', 'handoff_required']);
const ELIGIBILITY_STATUSES = objectFreeze(['eligible', 'handoff_required']);
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCATION_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const COLUMNS = EMAIL_LUNA_POLICY_AUDIT_RECORD_KEYS.join(', ');
const COLUMNS_086 = EMAIL_LUNA_POLICY_AUDIT_RECORD_KEYS_086.join(', ');
const SQL_LOCK_OPERATION = `SELECT ${COLUMNS} FROM tenant_email_luna_policy_audit WHERE operation_id = $1::uuid FOR UPDATE`;
const SQL_LOCK_ISSUANCE = `SELECT ${COLUMNS} FROM tenant_email_luna_policy_audit WHERE issuance_id = $1::uuid FOR UPDATE`;
const SQL_INSERT = `INSERT INTO tenant_email_luna_policy_audit (${COLUMNS}) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::uuid, $7::uuid, $8::text, $9::text, $10::text, $11::text, $12::text, $13::text, $14::text[]) RETURNING ${COLUMNS}`;
const SQL_LOCK_OPERATION_086 = `SELECT ${COLUMNS_086} FROM tenant_email_luna_policy_audit WHERE operation_id = $1::uuid FOR UPDATE`;
const SQL_LOCK_ISSUANCE_086 = `SELECT ${COLUMNS_086} FROM tenant_email_luna_policy_audit WHERE issuance_id = $1::uuid FOR UPDATE`;
const SQL_INSERT_086 = `INSERT INTO tenant_email_luna_policy_audit (${COLUMNS_086}) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::uuid, $7::uuid, $8::uuid, $9::text, $10::text, $11::text, $12::text, $13::text, $14::text, $15::text[]) RETURNING ${COLUMNS_086}`;

function invalid() {
  const error = new Error('Email Luna policy audit failed.');
  error.code = 'EMAIL_LUNA_POLICY_AUDIT_INVALID';
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
    if (error && error.code === 'EMAIL_LUNA_POLICY_AUDIT_INVALID') throw error;
    throw invalid();
  }
}

function parseUuid(raw) {
  if (typeof raw !== 'string') throw invalid();
  const id = raw.toLowerCase();
  if (!regexpTest(UUID_CANON, id) || id !== raw.toLowerCase() || raw.trim() !== raw) throw invalid();
  return id;
}

function canonicalFactRefs(trusted, decision) {
  if (trusted.status === 'handoff_required') return freeze([]);
  if (trusted.status !== 'draft_ready' || !decision || !objectIsFrozen(decision)) throw invalid();
  const value = decision.grounded_facts;
  if (value === null || typeof value !== 'object' || runtimeIsProxy(value) || !arrayIsArray(value)) throw invalid();
  const copy = [];
  for (let index = 0; index < value.length; index += 1) {
    const fact = value[index];
    if (typeof fact !== 'string' || !arrayIncludes(FACTS, fact)) throw invalid();
    for (let prior = 0; prior < index; prior += 1) if (copy[prior] === fact) throw invalid();
    copy[index] = fact;
  }
  return freeze(copy);
}

function schemaKeys(schemaVersion) {
  if (schemaVersion === EMAIL_LUNA_POLICY_AUDIT_SCHEMA_086) return EMAIL_LUNA_POLICY_AUDIT_RECORD_KEYS_086;
  if (schemaVersion === EMAIL_LUNA_POLICY_AUDIT_SCHEMA_085) return EMAIL_LUNA_POLICY_AUDIT_RECORD_KEYS;
  throw invalid();
}

function schemaSql(schemaVersion) {
  if (schemaVersion === EMAIL_LUNA_POLICY_AUDIT_SCHEMA_086) {
    return {
      lockOperation: SQL_LOCK_OPERATION_086,
      lockIssuance: SQL_LOCK_ISSUANCE_086,
      insert: SQL_INSERT_086,
    };
  }
  if (schemaVersion === EMAIL_LUNA_POLICY_AUDIT_SCHEMA_085) {
    return {
      lockOperation: SQL_LOCK_OPERATION,
      lockIssuance: SQL_LOCK_ISSUANCE,
      insert: SQL_INSERT,
    };
  }
  throw invalid();
}

function publicRecord(source, keys) {
  const record = objectCreate(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = objectGetOwnPropertyDescriptor(source, key);
    if (!descriptor || !objectHasOwn(descriptor, 'value')) throw invalid();
    if (key === 'fact_refs') {
      if (!arrayIsArray(descriptor.value)) throw invalid();
      record[key] = freeze(descriptor.value.slice());
    } else {
      record[key] = descriptor.value;
    }
  }
  return freeze(record);
}

function recordsEqual(left, right, keys) {
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === 'fact_refs') {
      const a = left[key];
      const b = right[key];
      if (!arrayIsArray(a) || !arrayIsArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    } else if (left[key] !== right[key]) return false;
  }
  return true;
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

function buildRecord(input, keys, schemaVersion) {
  const request = exactPlain(input, INPUT_KEYS);
  const operationId = parseUuid(request.operation_id);
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
  let eligibility;
  try {
    eligibility = assertEmailLunaAutonomousEligibilityOutput(request.eligibility);
  } catch (_) {
    throw invalid();
  }
  const issuanceId = readEmailLunaDraftPolicyIssuanceIdentity(request.evidence);
  if (readEmailLunaDraftPolicyIssuanceIdentity(request.decision) !== issuanceId) throw invalid();
  if (eligibility.client_id !== trusted.binding.client_id || eligibility.location_id !== trusted.binding.location_id || eligibility.conversation_id !== trusted.binding.conversation_id) throw invalid();
  if (eligibility.status === 'eligible' && eligibility.grounded_facts !== request.decision.grounded_facts) throw invalid();
  if (!arrayIncludes(CANONICAL_STATUSES, trusted.status)) throw invalid();
  if (!arrayIncludes(ELIGIBILITY_STATUSES, eligibility.status)) throw invalid();
  if (eligibility.status === 'eligible' && (trusted.status !== 'draft_ready' || eligibility.draft_only !== true
      || eligibility.send_allowed !== false || eligibility.auto_send_allowed !== false)) throw invalid();
  if (eligibility.status === 'handoff_required' && (eligibility.draft_only !== true || eligibility.send_allowed !== false
      || eligibility.auto_send_allowed !== false)) throw invalid();
  const locationKey = trusted.authority.location_key;
  if (typeof locationKey !== 'string' || !regexpTest(LOCATION_KEY_RE, locationKey) || locationKey.length > 64) throw invalid();
  const record = objectCreate(null);
  record.operation_id = operationId;
  record.issuance_id = issuanceId;
  record.client_id = trusted.binding.client_id;
  record.location_id = trusted.binding.location_id;
  record.location_key = locationKey;
  record.endpoint_id = trusted.authority.endpoint_id;
  record.conversation_id = trusted.binding.conversation_id;
  if (schemaVersion === EMAIL_LUNA_POLICY_AUDIT_SCHEMA_086) {
    record.inbound_event_id = parseUuid(trusted.authority.inbound_message_id);
  }
  record.policy_version = DRAFT_POLICY_VERSION;
  record.eligibility_policy_version = ELIGIBILITY_POLICY_VERSION;
  if (record.policy_version !== DRAFT_POLICY_VERSION || record.eligibility_policy_version !== ELIGIBILITY_POLICY_VERSION) throw invalid();
  record.canonical_status = trusted.status;
  record.canonical_reason = trusted.status === 'handoff_required' ? trusted.reason : null;
  record.eligibility_status = eligibility.status;
  record.eligibility_reason = eligibility.status === 'handoff_required' ? eligibility.reason : null;
  if (record.eligibility_status === 'handoff_required' && !arrayIncludes(ELIGIBILITY_REASONS, record.eligibility_reason)) throw invalid();
  if (record.canonical_status === 'handoff_required' && record.eligibility_status !== 'handoff_required') throw invalid();
  record.fact_refs = canonicalFactRefs(trusted, request.decision);
  return publicRecord(record, keys);
}

function insertParams(record, keys) {
  const params = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    params[index] = key === 'fact_refs' ? record[key].slice() : record[key];
  }
  return params;
}

function createEmailLunaPolicyAuditStore(dependencies) {
  const deps = exactPlain(dependencies, STORE_DEPENDENCY_KEYS);
  const withTransactionClient = deps.withTransactionClient;
  if (typeof withTransactionClient !== 'function' || runtimeIsProxy(withTransactionClient)) throw invalid();
  const schemaVersion = deps.schemaVersion;
  if (schemaVersion !== EMAIL_LUNA_POLICY_AUDIT_SCHEMA_085 && schemaVersion !== EMAIL_LUNA_POLICY_AUDIT_SCHEMA_086) throw invalid();
  const keys = schemaKeys(schemaVersion);
  const sql = schemaSql(schemaVersion);
  function persistPolicyAudit(input) {
    const record = buildRecord(input, keys, schemaVersion);
    return Promise.resolve(withTransactionClient(async (client) => {
      if (!client || typeof client !== 'object' || runtimeIsProxy(client) || typeof client.query !== 'function') throw invalid();
      const existingOp = queryRows(await Promise.resolve(client.query(sql.lockOperation, [record.operation_id])));
      if (existingOp.length > 1) throw invalid();
      if (existingOp.length === 1) {
        const current = publicRecord(existingOp[0], keys);
        if (recordsEqual(current, record, keys)) return output([['status', 'replayed'], ['record', current]]);
        return output([['status', 'conflict']]);
      }
      const existingIssuance = queryRows(await Promise.resolve(client.query(sql.lockIssuance, [record.issuance_id])));
      if (existingIssuance.length > 1) throw invalid();
      if (existingIssuance.length === 1) return output([['status', 'conflict']]);
      let inserted;
      try {
        inserted = queryRows(await Promise.resolve(client.query(sql.insert, insertParams(record, keys))));
      } catch (error) {
        if (ownErrorCode(error) === '23505') return output([['status', 'conflict']]);
        throw invalid();
      }
      if (inserted.length !== 1) throw invalid();
      return output([['status', 'committed'], ['record', publicRecord(inserted[0], keys)]]);
    }));
  }
  return freeze({ persistPolicyAudit });
}

module.exports = {
  createEmailLunaPolicyAuditStore,
  EMAIL_LUNA_POLICY_AUDIT_RUNTIME_WIRED,
  EMAIL_LUNA_POLICY_AUDIT_LOGGING_FORBIDDEN,
  EMAIL_LUNA_POLICY_AUDIT_SCHEMA_085,
  EMAIL_LUNA_POLICY_AUDIT_SCHEMA_086,
  EMAIL_LUNA_POLICY_AUDIT_RECORD_KEYS,
  EMAIL_LUNA_POLICY_AUDIT_RECORD_KEYS_086,
  SQL_LOCK_OPERATION,
  SQL_LOCK_ISSUANCE,
  SQL_INSERT,
  SQL_LOCK_OPERATION_086,
  SQL_LOCK_ISSUANCE_086,
  SQL_INSERT_086,
};
