'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 2.
 *
 * Durable provider-draft state machine store. Unwired: no worker composition,
 * no provider client, no token, no HTTP, no send.
 *
 * Trusted tenant/location/mailbox/inbound/thread/recipient/issuance facts are
 * loaded from Stage 1 rows inside SECURITY DEFINER functions. Request objects
 * cannot invent that scope.
 */

const util = require('node:util');
const nodeCrypto = require('node:crypto');

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const PINNED_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_TYPES && typeof PINNED_TYPES.isProxy === 'function'
  ? PINNED_TYPES.isProxy.bind(PINNED_TYPES)
  : null;
const cryptoCreateHash = typeof nodeCrypto.createHash === 'function'
  ? nodeCrypto.createHash.bind(nodeCrypto)
  : null;

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
const jsonStringify = JSON.stringify;
const jsonParse = JSON.parse;
const weakSetAdd = uncurryThis(WeakSet.prototype.add);
const weakSetHas = uncurryThis(WeakSet.prototype.has);
const AUTHENTIC_LOADED_OPERATIONS = new WeakSet();

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting operation failed.';
const EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_RUNTIME_WIRED = false;
const EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_LOGGING_FORBIDDEN = true;
const EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_PROVIDER = 'microsoft_graph';

const STORE_DEPENDENCY_KEYS = objectFreeze(['withTransactionClient']);
const RESERVE_KEYS = objectFreeze([
  'operation_id', 'issuance_id', 'canonical_subject', 'canonical_body', 'language',
]);
const OPERATION_ID_KEYS = objectFreeze(['operation_id', 'issuance_id']);
const CLAIM_KEYS = objectFreeze(['operation_id', 'issuance_id', 'expected_generation']);
const RECORD_KEYS = objectFreeze(['operation_id', 'issuance_id', 'expected_generation', 'acknowledgement']);
const RECONCILE_KEYS = objectFreeze(['operation_id', 'issuance_id', 'expected_generation', 'observation']);
const ACK_KEYS = objectFreeze([
  'body_digest',
  'client_id',
  'endpoint_id',
  'inbound_provider_message_id',
  'inbound_provider_thread_id',
  'is_draft',
  'issuance_id',
  'location_id',
  'location_key',
  'mailbox_id',
  'operation_id',
  'outcome',
  'provider',
  'provider_draft_id',
  'recipient_address',
  'subject_digest',
]);
const OBSERVATION_KINDS = objectFreeze([
  'exact', 'modified_by_staff', 'removed_by_staff', 'not_found', 'provider_mismatch',
]);
const STATES = objectFreeze([
  'reserved',
  'create_dispatched_outcome_unknown',
  'provider_draft_reconciled_exact',
  'provider_draft_modified_by_staff',
  'provider_draft_removed_by_staff',
  'provider_mismatch_blocked',
]);
const PUBLIC_KEYS = objectFreeze([
  'operation_id', 'issuance_id', 'audit_operation_id', 'client_id', 'location_id',
  'location_key', 'endpoint_id', 'conversation_id', 'inbound_event_id', 'provider',
  'mailbox_id', 'inbound_provider_message_id', 'inbound_provider_thread_id',
  'recipient_address', 'canonical_subject', 'canonical_body', 'subject_digest',
  'body_digest', 'draft_digest', 'policy_version', 'eligibility_policy_version',
  'validator_version', 'state', 'create_dispatch_claimed', 'provider_draft_id',
  'is_draft', 'state_generation',
]);
const FORBIDDEN_FIELD_NAMES = objectFreeze([
  'access_token', 'refresh_token', 'id_token', 'accessToken', 'refreshToken',
  'Authorization', 'authorization', 'token', 'client_secret', 'password',
  'api_key', 'raw_secret', 'send', 'send_invocation_count', 'authorize_send',
]);
const FORBIDDEN_STORE_METHODS = objectFreeze([
  'send', 'sendDraft', 'sendMail', 'authorizeSend', 'handoffToJournal',
]);
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const LOCATION_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PUBLIC_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GRAPH_ID_RE = /^[\x21-\x7e]+$/;
const PROVIDER_ID_FORBIDDEN_RE = /[/?#%\\]/;
const PROVIDER_ID_PERCENT_CONFUSION_RE = /%2e%2e|%2f|%5c/;

const EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_GRANT_CONTRACT = objectFreeze({
  table: 'tenant_email_luna_controlled_draft_operations',
  history_table: 'tenant_email_luna_controlled_draft_transitions',
  trusted_schema: 'public',
  search_path: objectFreeze(['pg_catalog', 'public']),
  function_owner: 'table_owner',
  worker_table_privileges: objectFreeze([]),
  worker_table_denied: objectFreeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
  producer_table_privileges: objectFreeze([]),
  producer_table_denied: objectFreeze(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']),
  producer_execute_functions: objectFreeze([
    'tenant_email_luna_controlled_draft_reserve',
    'tenant_email_luna_controlled_draft_load',
  ]),
  worker_execute_functions: objectFreeze([
    'tenant_email_luna_controlled_draft_claim_create',
    'tenant_email_luna_controlled_draft_record_create',
    'tenant_email_luna_controlled_draft_reconcile',
    'tenant_email_luna_controlled_draft_load',
  ]),
  operator_execute_functions: objectFreeze([]),
  no_custom_guc: true,
  no_synthetic_runtime_role_in_migration: true,
  no_grant_in_097: true,
  no_create_role_in_097: true,
  no_grant_in_098: true,
  no_create_role_in_098: true,
  apply_in: 'ch4_runtime_worker_and_operator_roles',
  worker_operation_select: false,
  producer_operation_select: false,
  no_send_phase: true,
  no_send_counter: true,
  no_send_authorization: true,
  no_outbound_journal_handoff: true,
});

const SQL_RESERVE = 'SELECT status, operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id, provider, mailbox_id, inbound_provider_message_id, inbound_provider_thread_id, recipient_address, canonical_subject, canonical_body, subject_digest, body_digest, draft_digest, policy_version, eligibility_policy_version, validator_version, state, create_dispatch_claimed, provider_draft_id, is_draft, state_generation FROM public.tenant_email_luna_controlled_draft_reserve($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text)';
const SQL_CLAIM = 'SELECT status, operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id, provider, mailbox_id, inbound_provider_message_id, inbound_provider_thread_id, recipient_address, canonical_subject, canonical_body, subject_digest, body_digest, draft_digest, policy_version, eligibility_policy_version, validator_version, state, create_dispatch_claimed, provider_draft_id, is_draft, state_generation FROM public.tenant_email_luna_controlled_draft_claim_create($1::uuid, $2::uuid, $3::integer)';
const SQL_RECORD = 'SELECT status, operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id, provider, mailbox_id, inbound_provider_message_id, inbound_provider_thread_id, recipient_address, canonical_subject, canonical_body, subject_digest, body_digest, draft_digest, policy_version, eligibility_policy_version, validator_version, state, create_dispatch_claimed, provider_draft_id, is_draft, state_generation FROM public.tenant_email_luna_controlled_draft_record_create($1::uuid, $2::uuid, $3::integer, $4::jsonb)';
const SQL_RECONCILE = 'SELECT status, operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id, provider, mailbox_id, inbound_provider_message_id, inbound_provider_thread_id, recipient_address, canonical_subject, canonical_body, subject_digest, body_digest, draft_digest, policy_version, eligibility_policy_version, validator_version, state, create_dispatch_claimed, provider_draft_id, is_draft, state_generation FROM public.tenant_email_luna_controlled_draft_reconcile($1::uuid, $2::uuid, $3::integer, $4::jsonb)';
const SQL_LOAD = 'SELECT status, operation_id, issuance_id, audit_operation_id, client_id, location_id, location_key, endpoint_id, conversation_id, inbound_event_id, provider, mailbox_id, inbound_provider_message_id, inbound_provider_thread_id, recipient_address, canonical_subject, canonical_body, subject_digest, body_digest, draft_digest, policy_version, eligibility_policy_version, validator_version, state, create_dispatch_claimed, provider_draft_id, is_draft, state_generation FROM public.tenant_email_luna_controlled_draft_load($1::uuid, $2::uuid)';

function invalid() {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  return objectFreeze(error);
}

function isProxySurface(value) {
  try {
    if (!PINNED_IS_PROXY) return true;
    return PINNED_IS_PROXY(value) === true;
  } catch (_) {
    return true;
  }
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

function rejectForbiddenFields(record) {
  const keys = safeOwnKeys(record);
  for (let i = 0; i < keys.length; i += 1) {
    if (arrayIncludes(FORBIDDEN_FIELD_NAMES, keys[i])) return false;
  }
  return true;
}

function exactPlain(value, keys) {
  if (value === null || typeof value !== 'object' || isProxySurface(value) || arrayIsArray(value)) throw invalid();
  try {
    const proto = objectGetPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw invalid();
    const ownKeys = safeOwnKeys(value);
    if (ownKeys.length !== keys.length) throw invalid();
    if (!rejectForbiddenFields(value)) throw invalid();
    const snapshot = objectCreate(null);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!arrayIncludes(ownKeys, key)) throw invalid();
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) throw invalid();
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (error && error.code === ERROR_CODE) throw error;
    throw invalid();
  }
}

function subsetPlain(value, allowed) {
  if (value === null || typeof value !== 'object' || isProxySurface(value) || arrayIsArray(value)) throw invalid();
  try {
    const proto = objectGetPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw invalid();
    const ownKeys = safeOwnKeys(value);
    if (!rejectForbiddenFields(value)) throw invalid();
    const snapshot = objectCreate(null);
    for (let index = 0; index < ownKeys.length; index += 1) {
      const key = ownKeys[index];
      if (typeof key !== 'string' || !arrayIncludes(allowed, key)) throw invalid();
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) throw invalid();
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (error && error.code === ERROR_CODE) throw error;
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

function parseOptionalGeneration(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 1000000000) throw invalid();
  return raw;
}

function isProviderId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) return false;
  if (value === '.' || value === '..') return false;
  if (!regexpTest(GRAPH_ID_RE, value)) return false;
  if (regexpTest(PROVIDER_ID_FORBIDDEN_RE, value)) return false;
  if (regexpTest(PROVIDER_ID_PERCENT_CONFUSION_RE, stringToLowerCase(value))) return false;
  return true;
}

function digestUtf8(value) {
  if (!cryptoCreateHash || typeof value !== 'string') throw invalid();
  try {
    const hasher = cryptoCreateHash('sha256');
    hasher.update(value, 'utf8');
    const hex = hasher.digest('hex');
    if (typeof hex !== 'string' || !regexpTest(DIGEST_RE, hex)) throw invalid();
    return hex;
  } catch (error) {
    if (error && error.code === ERROR_CODE) throw error;
    throw invalid();
  }
}

function draftDigest(subject, body, language) {
  if (!cryptoCreateHash) throw invalid();
  const hasher = cryptoCreateHash('sha256');
  hasher.update(subject).update('\0').update(body).update('\0').update(language);
  const hex = hasher.digest('hex');
  if (typeof hex !== 'string' || !regexpTest(DIGEST_RE, hex)) throw invalid();
  return hex;
}

function ownErrorCode(error) {
  try {
    if (error === null || typeof error !== 'object' || isProxySurface(error)) return undefined;
    const descriptor = objectGetOwnPropertyDescriptor(error, 'code');
    return descriptor && objectHasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch (_) {
    return undefined;
  }
}

function queryRows(result) {
  if (result === null || typeof result !== 'object' || isProxySurface(result) || arrayIsArray(result)) throw invalid();
  const descriptor = objectGetOwnPropertyDescriptor(result, 'rows');
  if (!descriptor || !objectHasOwn(descriptor, 'value') || !arrayIsArray(descriptor.value)) throw invalid();
  return descriptor.value;
}

function readField(source, key) {
  if (source === null || typeof source !== 'object' || isProxySurface(source) || arrayIsArray(source)) throw invalid();
  if (typeof key !== 'string') throw invalid();
  try {
    if (!objectHasOwn(source, key)) throw invalid();
    const descriptor = objectGetOwnPropertyDescriptor(source, key);
    if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) throw invalid();
    return descriptor.value;
  } catch (error) {
    if (error && error.code === ERROR_CODE) throw error;
    throw invalid();
  }
}

function resolveQuery(client) {
  if (!client || (typeof client !== 'object' && typeof client !== 'function') || isProxySurface(client)) return null;
  const own = objectGetOwnPropertyDescriptor(client, 'query');
  if (own) {
    return objectHasOwn(own, 'value') && typeof own.value === 'function' && !own.get && !own.set ? own.value : null;
  }
  let proto = objectGetPrototypeOf(client);
  let depth = 0;
  while (proto && proto !== Object.prototype && depth < 8) {
    if (isProxySurface(proto)) return null;
    const d = objectGetOwnPropertyDescriptor(proto, 'query');
    if (d) {
      return objectHasOwn(d, 'value') && typeof d.value === 'function' && !d.get && !d.set ? d.value : null;
    }
    proto = objectGetPrototypeOf(proto);
    depth += 1;
  }
  return null;
}

function pinClient(client) {
  const query = resolveQuery(client);
  if (typeof query !== 'function' || isProxySurface(query)) throw invalid();
  const pinned = client;
  return freeze({
    query(...args) {
      return query.apply(pinned, args);
    },
  });
}

function brandLoaded(row) {
  weakSetAdd(AUTHENTIC_LOADED_OPERATIONS, row);
  return row;
}

function assertAuthenticLoadedOperation(value) {
  if (value === null || typeof value !== 'object' || isProxySurface(value) || arrayIsArray(value)) throw invalid();
  if (objectGetPrototypeOf(value) !== null) throw invalid();
  if (!weakSetHas(AUTHENTIC_LOADED_OPERATIONS, value)) throw invalid();
  return value;
}

function publicOperation(source) {
  if (source === null || typeof source !== 'object' || isProxySurface(source) || arrayIsArray(source)) throw invalid();
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
  const provider = readField(source, 'provider');
  if (provider !== EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_PROVIDER) throw invalid();
  row.provider = provider;
  const mailboxId = readField(source, 'mailbox_id');
  const inboundMessage = readField(source, 'inbound_provider_message_id');
  const inboundThread = readField(source, 'inbound_provider_thread_id');
  if (!isProviderId(mailboxId) || !isProviderId(inboundMessage) || !isProviderId(inboundThread)) throw invalid();
  row.mailbox_id = mailboxId;
  row.inbound_provider_message_id = inboundMessage;
  row.inbound_provider_thread_id = inboundThread;
  const recipient = readField(source, 'recipient_address');
  if (typeof recipient !== 'string') throw invalid();
  const address = stringToLowerCase(stringTrim(recipient));
  if (!regexpTest(PUBLIC_ADDRESS_RE, address) || address.length < 3 || address.length > 320) throw invalid();
  row.recipient_address = address;
  const subject = readField(source, 'canonical_subject');
  const body = readField(source, 'canonical_body');
  if (typeof subject !== 'string' || typeof body !== 'string') throw invalid();
  if (subject.length < 1 || subject.length > 998 || body.length < 1 || body.length > 64000) throw invalid();
  row.canonical_subject = subject;
  row.canonical_body = body;
  const subjectDigest = readField(source, 'subject_digest');
  const bodyDigest = readField(source, 'body_digest');
  const digest = readField(source, 'draft_digest');
  if (typeof subjectDigest !== 'string' || !regexpTest(DIGEST_RE, subjectDigest)) throw invalid();
  if (typeof bodyDigest !== 'string' || !regexpTest(DIGEST_RE, bodyDigest)) throw invalid();
  if (typeof digest !== 'string' || !regexpTest(DIGEST_RE, digest)) throw invalid();
  row.subject_digest = subjectDigest;
  row.body_digest = bodyDigest;
  row.draft_digest = digest;
  row.policy_version = readField(source, 'policy_version');
  row.eligibility_policy_version = readField(source, 'eligibility_policy_version');
  row.validator_version = readField(source, 'validator_version');
  if (row.policy_version !== 'email-luna-draft-policy.v1') throw invalid();
  if (row.eligibility_policy_version !== 'email-luna-autonomous-eligibility-policy.v1') throw invalid();
  if (row.validator_version !== 'email-luna-draft-validator.v1') throw invalid();
  const state = readField(source, 'state');
  if (typeof state !== 'string' || !arrayIncludes(STATES, state)) throw invalid();
  row.state = state;
  row.create_dispatch_claimed = readField(source, 'create_dispatch_claimed') === true;
  const providerDraftId = readField(source, 'provider_draft_id');
  row.provider_draft_id = providerDraftId == null ? null : (isProviderId(providerDraftId) ? providerDraftId : (() => { throw invalid(); })());
  const isDraft = readField(source, 'is_draft');
  if (isDraft !== true && isDraft !== false && isDraft != null) throw invalid();
  row.is_draft = isDraft == null ? null : isDraft === true;
  const generation = readField(source, 'state_generation');
  const generationNumber = typeof generation === 'string' ? Number(generation) : generation;
  if (!Number.isInteger(generationNumber) || generationNumber < 1) throw invalid();
  row.state_generation = generationNumber;
  const frozen = freeze(row);
  return brandLoaded(frozen);
}

function closedAck(raw) {
  const parsed = exactPlain(raw, ACK_KEYS);
  if (parsed.outcome !== 'draft_created') throw invalid();
  if (parsed.provider !== EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_PROVIDER) throw invalid();
  if (parsed.is_draft !== true && parsed.is_draft !== false) throw invalid();
  if (!isProviderId(parsed.provider_draft_id) || !isProviderId(parsed.mailbox_id)
      || !isProviderId(parsed.inbound_provider_message_id)
      || !isProviderId(parsed.inbound_provider_thread_id)) throw invalid();
  parseUuidRequired(parsed.client_id);
  parseUuidRequired(parsed.location_id);
  parseUuidRequired(parsed.endpoint_id);
  parseUuidRequired(parsed.issuance_id);
  parseUuidRequired(parsed.operation_id);
  if (typeof parsed.location_key !== 'string' || !regexpTest(LOCATION_KEY_RE, parsed.location_key)) throw invalid();
  if (typeof parsed.subject_digest !== 'string' || !regexpTest(DIGEST_RE, parsed.subject_digest)) throw invalid();
  if (typeof parsed.body_digest !== 'string' || !regexpTest(DIGEST_RE, parsed.body_digest)) throw invalid();
  const recipient = stringToLowerCase(stringTrim(parsed.recipient_address));
  if (!regexpTest(PUBLIC_ADDRESS_RE, recipient)) throw invalid();
  const encoded = jsonStringify(parsed);
  if (typeof encoded !== 'string' || encoded.length > 8192) throw invalid();
  return jsonParse(encoded);
}

function closedObservation(raw) {
  const allowed = objectFreeze([
    'kind', 'provider_draft_id', 'is_draft', 'subject_digest', 'body_digest',
  ]);
  const parsed = subsetPlain(raw, allowed);
  if (typeof parsed.kind !== 'string' || !arrayIncludes(OBSERVATION_KINDS, parsed.kind)) throw invalid();
  if (objectHasOwn(parsed, 'provider_draft_id') && !isProviderId(parsed.provider_draft_id)) throw invalid();
  if (objectHasOwn(parsed, 'is_draft') && parsed.is_draft !== true && parsed.is_draft !== false) throw invalid();
  if (objectHasOwn(parsed, 'subject_digest') && (typeof parsed.subject_digest !== 'string' || !regexpTest(DIGEST_RE, parsed.subject_digest))) throw invalid();
  if (objectHasOwn(parsed, 'body_digest') && (typeof parsed.body_digest !== 'string' || !regexpTest(DIGEST_RE, parsed.body_digest))) throw invalid();
  if (parsed.kind === 'exact') {
    if (!objectHasOwn(parsed, 'provider_draft_id') || !objectHasOwn(parsed, 'is_draft')
        || !objectHasOwn(parsed, 'subject_digest') || !objectHasOwn(parsed, 'body_digest')) {
      throw invalid();
    }
  }
  const encoded = jsonStringify(parsed);
  if (typeof encoded !== 'string' || encoded.length > 4096) throw invalid();
  return jsonParse(encoded);
}

async function withOuterTxn(client, fn) {
  let begun = false;
  let commitSent = false;
  try {
    await client.query('BEGIN');
    begun = true;
    const result = await fn();
    commitSent = true;
    await client.query('COMMIT');
    begun = false;
    return result;
  } catch (error) {
    if (begun) {
      try { await client.query('ROLLBACK'); } catch (_) { /* best-effort */ }
    }
    if (ownErrorCode(error) === ERROR_CODE) throw error;
    if (ownErrorCode(error) === '23514' || ownErrorCode(error) === '23505') throw invalid();
    throw invalid();
  } finally {
    void commitSent;
  }
}

function mapStatus(status) {
  if (typeof status !== 'string') throw invalid();
  if (status === 'reserved' || status === 'replayed' || status === 'loaded'
      || status === 'create_dispatched_outcome_unknown' || status === 'stale_generation'
      || arrayIncludes(STATES, status)) {
    return status;
  }
  throw invalid();
}

function createEmailLunaControlledDraftingOperationStore(dependencies) {
  if (arguments.length !== 1) throw invalid();
  const deps = exactPlain(dependencies, STORE_DEPENDENCY_KEYS);
  const withTransactionClient = deps.withTransactionClient;
  if (typeof withTransactionClient !== 'function' || isProxySurface(withTransactionClient)) throw invalid();

  async function run(work) {
    return Promise.resolve(withTransactionClient(async (client) => {
      const pinned = pinClient(client);
      return withOuterTxn(pinned, () => work(pinned));
    }));
  }

  function reserveControlledDraft(input) {
    const request = exactPlain(input, RESERVE_KEYS);
    const operationId = parseUuidRequired(request.operation_id);
    const issuanceId = parseUuidRequired(request.issuance_id);
    if (typeof request.canonical_subject !== 'string' || request.canonical_subject.length < 1
        || request.canonical_subject.length > 998 || request.canonical_subject !== stringTrim(request.canonical_subject)
        || /[\x00-\x1f\x7f]/.test(request.canonical_subject)) throw invalid();
    if (typeof request.canonical_body !== 'string' || request.canonical_body.length < 1
        || request.canonical_body.length > 64000) throw invalid();
    if (request.language !== 'en' && request.language !== 'es') throw invalid();
    const subjectDigest = digestUtf8(request.canonical_subject);
    const bodyDigest = digestUtf8(request.canonical_body);
    const digest = draftDigest(request.canonical_subject, request.canonical_body, request.language);
    return run(async (client) => {
      const rows = queryRows(await client.query(SQL_RESERVE, [
        operationId, issuanceId, request.canonical_subject, request.canonical_body,
        request.language, subjectDigest, bodyDigest, digest,
      ]));
      if (rows.length !== 1) throw invalid();
      return output([['status', mapStatus(readField(rows[0], 'status'))], ['record', publicOperation(rows[0])]]);
    });
  }

  function claimCreateDispatch(input) {
    const request = exactPlain(input, CLAIM_KEYS);
    const operationId = parseUuidRequired(request.operation_id);
    const issuanceId = parseUuidRequired(request.issuance_id);
    const expected = parseOptionalGeneration(request.expected_generation);
    return run(async (client) => {
      const rows = queryRows(await client.query(SQL_CLAIM, [operationId, issuanceId, expected]));
      if (rows.length !== 1) throw invalid();
      return output([['status', mapStatus(readField(rows[0], 'status'))], ['record', publicOperation(rows[0])]]);
    });
  }

  function recordProviderCreate(input) {
    const request = exactPlain(input, RECORD_KEYS);
    const operationId = parseUuidRequired(request.operation_id);
    const issuanceId = parseUuidRequired(request.issuance_id);
    const expected = parseOptionalGeneration(request.expected_generation);
    const ack = closedAck(request.acknowledgement);
    if (ack.operation_id !== operationId || ack.issuance_id !== issuanceId) throw invalid();
    return run(async (client) => {
      const rows = queryRows(await client.query(SQL_RECORD, [operationId, issuanceId, expected, ack]));
      if (rows.length !== 1) throw invalid();
      return output([['status', mapStatus(readField(rows[0], 'status'))], ['record', publicOperation(rows[0])]]);
    });
  }

  function reconcileProviderDraft(input) {
    const request = exactPlain(input, RECONCILE_KEYS);
    const operationId = parseUuidRequired(request.operation_id);
    const issuanceId = parseUuidRequired(request.issuance_id);
    const expected = parseOptionalGeneration(request.expected_generation);
    const observation = closedObservation(request.observation);
    return run(async (client) => {
      const rows = queryRows(await client.query(SQL_RECONCILE, [operationId, issuanceId, expected, observation]));
      if (rows.length !== 1) throw invalid();
      return output([['status', mapStatus(readField(rows[0], 'status'))], ['record', publicOperation(rows[0])]]);
    });
  }

  function loadControlledDraft(input) {
    const request = exactPlain(input, OPERATION_ID_KEYS);
    const operationId = parseUuidRequired(request.operation_id);
    const issuanceId = parseUuidRequired(request.issuance_id);
    return run(async (client) => {
      const rows = queryRows(await client.query(SQL_LOAD, [operationId, issuanceId]));
      if (rows.length !== 1) return output([['status', 'empty']]);
      return output([['status', mapStatus(readField(rows[0], 'status'))], ['record', publicOperation(rows[0])]]);
    });
  }

  const store = objectCreate(null);
  objectDefineProperty(store, 'reserveControlledDraft', { value: reserveControlledDraft, enumerable: true, writable: false, configurable: false });
  objectDefineProperty(store, 'claimCreateDispatch', { value: claimCreateDispatch, enumerable: true, writable: false, configurable: false });
  objectDefineProperty(store, 'recordProviderCreate', { value: recordProviderCreate, enumerable: true, writable: false, configurable: false });
  objectDefineProperty(store, 'reconcileProviderDraft', { value: reconcileProviderDraft, enumerable: true, writable: false, configurable: false });
  objectDefineProperty(store, 'loadControlledDraft', { value: loadControlledDraft, enumerable: true, writable: false, configurable: false });
  objectDefineProperty(store, 'assertAuthenticLoadedOperation', { value: assertAuthenticLoadedOperation, enumerable: true, writable: false, configurable: false });
  for (let i = 0; i < FORBIDDEN_STORE_METHODS.length; i += 1) {
    if (objectHasOwn(store, FORBIDDEN_STORE_METHODS[i])) throw invalid();
  }
  return freeze(store);
}

module.exports = objectFreeze({
  createEmailLunaControlledDraftingOperationStore,
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_RUNTIME_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_LOGGING_FORBIDDEN,
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_PROVIDER,
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_GRANT_CONTRACT,
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATION_STATES: STATES,
  STORE_DEPENDENCY_KEYS,
  RESERVE_KEYS,
  CLAIM_KEYS,
  RECORD_KEYS,
  RECONCILE_KEYS,
  ACK_KEYS,
  PUBLIC_KEYS,
  assertAuthenticLoadedOperation,
});
