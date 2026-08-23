'use strict';

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);
const nodeCrypto = require('node:crypto');
const { assertEmailLunaDraftPolicyIssuance } = require('./email-luna-draft-policy');
const { recomputeEmailLunaDraftCanonicalFromAuthentic } = require('./email-luna-draft-author');
const { assertEmailLunaDraftValidation } = require('./email-luna-draft-validator');

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

const EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RUNTIME_WIRED = false;
const EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_LOGGING_FORBIDDEN = true;
const STORE_DEPENDENCY_KEYS = objectFreeze(['withTransactionClient']);
const HANDOFF_KEYS = objectFreeze([
  'operation_id', 'owner_token', 'envelope', 'evidence', 'decision', 'draft', 'validation',
]);
const QUEUE_KEYS = objectFreeze([
  'operation_id', 'issuance_id', 'audit_operation_id', 'client_id', 'location_id', 'location_key',
  'endpoint_id', 'conversation_id', 'inbound_event_id', 'recipient_address', 'draft_digest',
  'state', 'attempt_count', 'lease_owner', 'handoff_id',
]);
const JOURNAL_KEYS = objectFreeze([
  'operation_id', 'phase', 'outcome', 'body_digest', 'immutable_draft_id', 'approval_id',
  'actor_staff_user_id', 'provider', 'create_invocation_count', 'update_invocation_count',
  'send_invocation_count', 'luna_automation_operation_id', 'luna_automation_issuance_id',
  'luna_automation_audit_operation_id', 'luna_inbound_event_id', 'luna_recipient_address',
  'luna_replay_owner_digest',
  'client_id', 'location_id', 'location_key', 'endpoint_id', 'conversation_id',
]);
const RECORD_KEYS = objectFreeze([
  'operation_id', 'issuance_id', 'handoff_id', 'journal_operation_id', 'journal_phase',
  'journal_outcome', 'journal_body_digest', 'client_id', 'location_id', 'location_key',
  'endpoint_id', 'conversation_id', 'inbound_event_id', 'recipient_address', 'draft_digest',
  'create_invocation_count', 'update_invocation_count', 'send_invocation_count',
  'immutable_draft_id', 'approval_id',
]);
const EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT = objectFreeze({
  queue_table: 'tenant_email_luna_automation_queue',
  journal_table: 'tenant_email_outbound_send_journal',
  trusted_schema: 'public',
  search_path: objectFreeze(['pg_catalog', 'public']),
  function_owner: 'table_owner',
  worker_table_privileges: objectFreeze({
    tenant_email_luna_automation_queue: objectFreeze(['SELECT']),
    tenant_email_outbound_send_journal: objectFreeze(['SELECT']),
  }),
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
  no_grant_in_087: true,
  apply_in: 'ch4_runtime_worker_and_operator_roles',
  replay_authority: 'privileged_function_one_way_owner_digest',
  replay_owner_digest_prefix: 'luna-replay-owner-v1:',
  replay_authority_note: 'This proof secures the privileged tenant_email_luna_automation_handoff replay function. General table SELECT scoping is a later runtime-role/RLS decision only if existing architecture already treats the worker as service-wide trusted.',
});
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCATION_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PUBLIC_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const QUEUE_COLUMNS = QUEUE_KEYS.join(', ');
const JOURNAL_COLUMNS = JOURNAL_KEYS.join(', ');
const SQL_LOCK_QUEUE = `SELECT ${QUEUE_COLUMNS} FROM tenant_email_luna_automation_queue WHERE operation_id = $1::uuid FOR UPDATE`;
const SQL_LOCK_JOURNAL = `SELECT ${JOURNAL_COLUMNS} FROM tenant_email_outbound_send_journal WHERE operation_id = $1::uuid FOR UPDATE`;
const SQL_HANDOFF = `SELECT ${QUEUE_COLUMNS} FROM tenant_email_luna_automation_handoff($1::uuid, $2::uuid)`;

function invalid() {
  const error = new Error('Email Luna automation journal handoff failed.');
  error.code = 'EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_INVALID';
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
    if (error && error.code === 'EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_INVALID') throw error;
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

function parseUuidOrNull(raw) {
  if (raw === null || raw === undefined) return null;
  return parseUuidRequired(raw);
}

function parseCount(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 1) return raw;
  if (typeof raw === 'string' && regexpTest(/^[01]$/, raw)) return Number(raw);
  throw invalid();
}

function normalizeRecipient(raw) {
  if (typeof raw !== 'string') throw invalid();
  const address = stringToLowerCase(stringTrim(raw));
  if (!regexpTest(PUBLIC_ADDRESS_RE, address) || address.length < 3 || address.length > 320) throw invalid();
  return address;
}

function replayOwnerDigest(owner) {
  if (!cryptoCreateHash) throw invalid();
  const digest = cryptoCreateHash('sha256')
    .update(EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT.replay_owner_digest_prefix + owner)
    .digest('hex');
  if (!regexpTest(DIGEST_RE, digest)) throw invalid();
  return digest;
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

function ownErrorCode(error) {
  try {
    if (error === null || typeof error !== 'object' || runtimeIsProxy(error)) return undefined;
    const descriptor = objectGetOwnPropertyDescriptor(error, 'code');
    return descriptor && objectHasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch (_) {
    return undefined;
  }
}

function ownErrorMessage(error) {
  try {
    if (error === null || typeof error !== 'object' || runtimeIsProxy(error)) return '';
    const descriptor = objectGetOwnPropertyDescriptor(error, 'message');
    return descriptor && objectHasOwn(descriptor, 'value') && typeof descriptor.value === 'string' ? descriptor.value : '';
  } catch (_) {
    return '';
  }
}

function queryRows(result) {
  if (result === null || typeof result !== 'object' || runtimeIsProxy(result) || arrayIsArray(result)) throw invalid();
  const descriptor = objectGetOwnPropertyDescriptor(result, 'rows');
  if (!descriptor || !objectHasOwn(descriptor, 'value') || !arrayIsArray(descriptor.value)) throw invalid();
  return descriptor.value;
}

function read(source, key) {
  const descriptor = objectGetOwnPropertyDescriptor(source, key);
  return descriptor && objectHasOwn(descriptor, 'value') ? descriptor.value : source[key];
}

function publicQueue(source) {
  if (source === null || typeof source !== 'object' || runtimeIsProxy(source) || arrayIsArray(source)) throw invalid();
  const record = objectCreate(null);
  record.operation_id = parseUuidRequired(read(source, 'operation_id'));
  record.issuance_id = parseUuidRequired(read(source, 'issuance_id'));
  record.audit_operation_id = parseUuidRequired(read(source, 'audit_operation_id'));
  record.client_id = parseUuidRequired(read(source, 'client_id'));
  record.location_id = parseUuidRequired(read(source, 'location_id'));
  const locationKey = read(source, 'location_key');
  if (typeof locationKey !== 'string' || !regexpTest(LOCATION_KEY_RE, locationKey) || locationKey.length > 64) throw invalid();
  record.location_key = locationKey;
  record.endpoint_id = parseUuidRequired(read(source, 'endpoint_id'));
  record.conversation_id = parseUuidRequired(read(source, 'conversation_id'));
  record.inbound_event_id = parseUuidRequired(read(source, 'inbound_event_id'));
  record.recipient_address = normalizeRecipient(read(source, 'recipient_address'));
  const digest = read(source, 'draft_digest');
  if (typeof digest !== 'string' || !regexpTest(DIGEST_RE, digest)) throw invalid();
  record.draft_digest = digest;
  record.state = read(source, 'state');
  if (record.state !== 'pending' && record.state !== 'claimed' && record.state !== 'handed_off'
      && record.state !== 'handoff_required' && record.state !== 'cancelled') throw invalid();
  record.attempt_count = typeof read(source, 'attempt_count') === 'number' ? read(source, 'attempt_count') : Number(read(source, 'attempt_count'));
  record.lease_owner = parseUuidOrNull(read(source, 'lease_owner'));
  record.handoff_id = parseUuidOrNull(read(source, 'handoff_id'));
  return freeze(record);
}

function publicJournal(source) {
  if (source === null || typeof source !== 'object' || runtimeIsProxy(source) || arrayIsArray(source)) throw invalid();
  const record = objectCreate(null);
  record.operation_id = parseUuidRequired(read(source, 'operation_id'));
  record.phase = read(source, 'phase');
  record.outcome = read(source, 'outcome');
  const digest = read(source, 'body_digest');
  if (typeof digest !== 'string' || !regexpTest(DIGEST_RE, digest)) throw invalid();
  record.body_digest = digest;
  record.immutable_draft_id = read(source, 'immutable_draft_id') == null ? null : read(source, 'immutable_draft_id');
  record.approval_id = parseUuidOrNull(read(source, 'approval_id'));
  record.actor_staff_user_id = parseUuidOrNull(read(source, 'actor_staff_user_id'));
  record.provider = read(source, 'provider');
  record.create_invocation_count = parseCount(read(source, 'create_invocation_count'));
  record.update_invocation_count = parseCount(read(source, 'update_invocation_count'));
  record.send_invocation_count = parseCount(read(source, 'send_invocation_count'));
  record.luna_automation_operation_id = parseUuidOrNull(read(source, 'luna_automation_operation_id'));
  record.luna_automation_issuance_id = parseUuidOrNull(read(source, 'luna_automation_issuance_id'));
  record.luna_automation_audit_operation_id = parseUuidOrNull(read(source, 'luna_automation_audit_operation_id'));
  record.luna_inbound_event_id = parseUuidOrNull(read(source, 'luna_inbound_event_id'));
  const recipient = read(source, 'luna_recipient_address');
  record.luna_recipient_address = recipient == null ? null : normalizeRecipient(recipient);
  const replayDigest = read(source, 'luna_replay_owner_digest');
  if (typeof replayDigest !== 'string' || !regexpTest(DIGEST_RE, replayDigest)) throw invalid();
  record.luna_replay_owner_digest = replayDigest;
  record.client_id = parseUuidRequired(read(source, 'client_id'));
  record.location_id = parseUuidRequired(read(source, 'location_id'));
  const locationKey = read(source, 'location_key');
  if (typeof locationKey !== 'string' || !regexpTest(LOCATION_KEY_RE, locationKey) || locationKey.length > 64) throw invalid();
  record.location_key = locationKey;
  record.endpoint_id = parseUuidRequired(read(source, 'endpoint_id'));
  record.conversation_id = parseUuidRequired(read(source, 'conversation_id'));
  return freeze(record);
}

function linkedRecord(queue, journal) {
  return freeze({
    operation_id: queue.operation_id,
    issuance_id: queue.issuance_id,
    handoff_id: queue.handoff_id,
    journal_operation_id: journal.operation_id,
    journal_phase: journal.phase,
    journal_outcome: journal.outcome,
    journal_body_digest: journal.body_digest,
    client_id: queue.client_id,
    location_id: queue.location_id,
    location_key: queue.location_key,
    endpoint_id: queue.endpoint_id,
    conversation_id: queue.conversation_id,
    inbound_event_id: queue.inbound_event_id,
    recipient_address: queue.recipient_address,
    draft_digest: queue.draft_digest,
    create_invocation_count: journal.create_invocation_count,
    update_invocation_count: journal.update_invocation_count,
    send_invocation_count: journal.send_invocation_count,
    immutable_draft_id: journal.immutable_draft_id,
    approval_id: journal.approval_id,
  });
}

function identityMatch(queue, journal, digest) {
  return journal.operation_id === queue.operation_id
    && journal.luna_automation_operation_id === queue.operation_id
    && journal.luna_automation_issuance_id === queue.issuance_id
    && journal.luna_automation_audit_operation_id === queue.audit_operation_id
    && journal.client_id === queue.client_id
    && journal.location_id === queue.location_id
    && journal.location_key === queue.location_key
    && journal.endpoint_id === queue.endpoint_id
    && journal.conversation_id === queue.conversation_id
    && journal.luna_inbound_event_id === queue.inbound_event_id
    && journal.luna_recipient_address === queue.recipient_address
    && journal.body_digest === queue.draft_digest
    && journal.body_digest === digest
    && queue.draft_digest === digest
    && queue.handoff_id === journal.operation_id
    && journal.phase === 'handoff_established'
    && journal.outcome === 'handed_off'
    && journal.immutable_draft_id === null
    && journal.approval_id === null
    && journal.actor_staff_user_id === null
    && journal.provider === 'microsoft_graph'
    && journal.create_invocation_count === 0
    && journal.update_invocation_count === 0
    && journal.send_invocation_count === 0
    && typeof journal.luna_replay_owner_digest === 'string'
    && regexpTest(DIGEST_RE, journal.luna_replay_owner_digest)
    && queue.state === 'handed_off';
}

function proveAuthenticDigest(input) {
  let trusted;
  try {
    trusted = assertEmailLunaDraftPolicyIssuance({
      envelope: input.envelope,
      evidence: input.evidence,
      decision: input.decision,
    });
  } catch (_) {
    throw invalid();
  }
  if (!trusted || trusted.status !== 'draft_ready') throw invalid();
  let validation;
  try {
    validation = assertEmailLunaDraftValidation(input.validation);
  } catch (_) {
    throw invalid();
  }
  if (validation.status !== 'valid') throw invalid();
  if (validation.send_allowed !== false || validation.auto_send_allowed !== false) throw invalid();
  try {
    recomputeEmailLunaDraftCanonicalFromAuthentic({
      envelope: input.envelope,
      evidence: input.evidence,
      decision: input.decision,
      draft: input.draft,
    });
  } catch (_) {
    throw invalid();
  }
  const digest = draftDigest(input.draft);
  if (validation.client_id !== trusted.binding.client_id || validation.location_id !== trusted.binding.location_id
      || validation.conversation_id !== trusted.binding.conversation_id) throw invalid();
  return { digest, trusted };
}

function handedOffResult(queue, journal, replayed) {
  return output([
    ['status', replayed ? 'replayed' : 'handed_off'],
    ['record', linkedRecord(queue, journal)],
    ['authorize_create', false],
    ['authorize_update', false],
    ['authorize_dispatch', false],
  ]);
}

async function attemptRollback(client) {
  try { await client.query('ROLLBACK'); } catch (_) { /* best-effort */ }
}

async function withOuterTxn(client, fn) {
  let begun = false;
  let commitSent = false;
  try {
    await client.query('BEGIN');
    begun = true;
    const result = await fn();
    if (result && result.status && result.status !== 'handed_off' && result.status !== 'replayed') {
      await client.query('ROLLBACK');
      begun = false;
      return result;
    }
    commitSent = true;
    await client.query('COMMIT');
    begun = false;
    commitSent = false;
    return result;
  } catch (error) {
    if (commitSent) {
      await attemptRollback(client);
      return output([['status', 'commit_outcome_unknown']]);
    }
    if (begun) await attemptRollback(client);
    const code = ownErrorCode(error);
    const message = ownErrorMessage(error);
    if (code === '23514' && /journal identity conflict/.test(message)) {
      return output([['status', 'identity_conflict']]);
    }
    if (code === 'EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_INVALID') throw error;
    throw invalid();
  }
}

function createEmailLunaAutomationJournalHandoffStore(dependencies) {
  const deps = exactPlain(dependencies, STORE_DEPENDENCY_KEYS);
  const withTransactionClient = deps.withTransactionClient;
  if (typeof withTransactionClient !== 'function' || runtimeIsProxy(withTransactionClient)) throw invalid();

  function establishCanonicalJournalHandoff(input) {
    return Promise.resolve().then(() => {
      const request = exactPlain(input, HANDOFF_KEYS);
      const operationId = parseUuidRequired(request.operation_id);
      const owner = parseUuidRequired(request.owner_token);
      const proven = proveAuthenticDigest(request);
      return withTransactionClient(async (client) => {
      if (!client || typeof client !== 'object' || runtimeIsProxy(client) || typeof client.query !== 'function') throw invalid();
      return withOuterTxn(client, async () => {
        const lockedQueue = queryRows(await Promise.resolve(client.query(SQL_LOCK_QUEUE, [operationId])));
        if (lockedQueue.length !== 1) return output([['status', 'conflict']]);
        const queueBefore = publicQueue(lockedQueue[0]);
        if (queueBefore.draft_digest !== proven.digest) return output([['status', 'identity_conflict']]);
        if (queueBefore.client_id !== proven.trusted.binding.client_id
            || queueBefore.location_id !== proven.trusted.binding.location_id
            || queueBefore.conversation_id !== proven.trusted.binding.conversation_id) {
          return output([['status', 'identity_conflict']]);
        }
        if (queueBefore.state === 'handed_off') {
          const journals = queryRows(await Promise.resolve(client.query(SQL_LOCK_JOURNAL, [operationId])));
          if (journals.length !== 1) return output([['status', 'identity_conflict']]);
          const journal = publicJournal(journals[0]);
          if (!identityMatch(queueBefore, journal, proven.digest)) return output([['status', 'identity_conflict']]);
          if (journal.luna_replay_owner_digest !== replayOwnerDigest(owner)) {
            return output([['status', 'conflict']]);
          }
          let handed;
          try {
            handed = queryRows(await Promise.resolve(client.query(SQL_HANDOFF, [operationId, owner])));
          } catch (error) {
            const code = ownErrorCode(error);
            const message = ownErrorMessage(error);
            if (code === '23514' && /journal identity conflict/.test(message)) return output([['status', 'identity_conflict']]);
            throw error;
          }
          if (handed.length !== 1) return output([['status', 'conflict']]);
          return handedOffResult(queueBefore, journal, true);
        }
        if (queueBefore.state !== 'claimed' || queueBefore.lease_owner !== owner || queueBefore.handoff_id !== null) {
          return output([['status', 'conflict']]);
        }
        let handed;
        try {
          handed = queryRows(await Promise.resolve(client.query(SQL_HANDOFF, [operationId, owner])));
        } catch (error) {
          const code = ownErrorCode(error);
          const message = ownErrorMessage(error);
          if (code === '23514' && /journal identity conflict/.test(message)) return output([['status', 'identity_conflict']]);
          throw error;
        }
        if (handed.length !== 1) return output([['status', 'conflict']]);
        const queueAfter = publicQueue(handed[0]);
        const journals = queryRows(await Promise.resolve(client.query(SQL_LOCK_JOURNAL, [operationId])));
        if (journals.length !== 1) return output([['status', 'identity_conflict']]);
        const journal = publicJournal(journals[0]);
        if (!identityMatch(queueAfter, journal, proven.digest)) return output([['status', 'identity_conflict']]);
        if (journal.luna_replay_owner_digest !== replayOwnerDigest(owner)) return output([['status', 'identity_conflict']]);
        return handedOffResult(queueAfter, journal, false);
      });
      });
    });
  }

  return freeze({ establishCanonicalJournalHandoff });
}

module.exports = {
  createEmailLunaAutomationJournalHandoffStore,
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_LOGGING_FORBIDDEN,
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_GRANT_CONTRACT,
  EMAIL_LUNA_AUTOMATION_JOURNAL_HANDOFF_RECORD_KEYS: RECORD_KEYS,
  SQL_LOCK_QUEUE,
  SQL_LOCK_JOURNAL,
  SQL_HANDOFF,
};
