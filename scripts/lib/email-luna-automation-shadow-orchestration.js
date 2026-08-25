'use strict';

/**
 * FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B2: shadow-only orchestration owner.
 *
 * Consumes canonical policy issuance, persists authentic 086 audit plus producer
 * persist_and_enqueue (issuance material + queue identity) on the would-send
 * path, and returns a staff-safe would-send/handoff projection. Default-off.
 * Send-inert: no claim, no journal handoff, no provider, no send permission.
 */

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);
const { createEmailLunaDraftHandoff } = require('./email-luna-draft-handoff-contract');
const {
  assertEmailLunaDraftPolicyIssuance,
  readEmailLunaDraftPolicyIssuanceIdentity,
  EMAIL_LUNA_DRAFT_POLICY_VERSION,
  createEmailLunaAutomationIssuanceMaterialStore,
} = require('./email-luna-draft-policy');
const {
  decideEmailLunaAutonomousEligibility,
  EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION,
} = require('./email-luna-autonomous-eligibility-policy');
const {
  createEmailLunaPolicyAuditStore,
  EMAIL_LUNA_POLICY_AUDIT_SCHEMA_086,
} = require('./email-luna-policy-audit-store');

const arrayIncludes = uncurryThis(Array.prototype.includes);
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
const arraySome = uncurryThis(Array.prototype.some);
const regexpTest = uncurryThis(RegExp.prototype.test);
const stringTrim = uncurryThis(String.prototype.trim);
const stringToLowerCase = uncurryThis(String.prototype.toLowerCase);
const weakSetAdd = uncurryThis(WeakSet.prototype.add);
const weakSetHas = uncurryThis(WeakSet.prototype.has);

const AUTHENTIC_SHADOW_PROJECTIONS = new WeakSet();
const EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED = false;
const EMAIL_LUNA_AUTOMATION_SHADOW_LOGGING_FORBIDDEN = true;
const ENV_SHADOW_ENABLED = 'EMAIL_LUNA_AUTOMATION_SHADOW_ENABLED';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const SUNSET_LOCATION_KEY = 'sunset-somo';
const SHADOW_MODE = 'shadow';
const DRAFT_POLICY_VERSION = EMAIL_LUNA_DRAFT_POLICY_VERSION;
const ELIGIBILITY_POLICY_VERSION = EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION;

const FACTORY_KEYS = objectFreeze(['withTransactionClient', 'env', 'tenant_location_gate']);
const ENV_KEYS = objectFreeze(['LUNA_DEPLOYMENT', ENV_SHADOW_ENABLED]);
const GATE_KEYS = objectFreeze(['client_id', 'location_id', 'location_key', 'shadow_enabled']);
const ENABLED_INPUT_KEYS = objectFreeze(['env', 'tenant_location_gate', 'authority']);
const AUTHORITY_KEYS = objectFreeze(['client_id', 'location_id', 'location_key']);
const BASE_KEYS = objectFreeze(['operation_id', 'envelope', 'evidence', 'decision']);
const READY_KEYS = objectFreeze(['operation_id', 'envelope', 'evidence', 'decision', 'draft', 'validation']);
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const FORBIDDEN_INPUT_KEYS = objectFreeze([
  'status', 'would_send', 'would_not_send', 'send', 'provider', 'callback', 'onSend',
  'authorize_dispatch', 'authorize_create', 'authorize_update', 'owner_token', 'claim',
  'handoff', 'client_id', 'location_id', 'recipient_address', 'recipient', 'capability',
  'facts', 'tenant', 'mode', 'send_allowed', 'auto_send_allowed', 'provider_invoked',
]);

function invalid() {
  const error = new Error('Email Luna automation shadow orchestration failed.');
  error.code = 'EMAIL_LUNA_AUTOMATION_SHADOW_INVALID';
  return error;
}

function disabledError() {
  const error = new Error('Email Luna automation shadow disabled.');
  error.code = 'EMAIL_LUNA_AUTOMATION_SHADOW_DISABLED';
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
  const frozen = freeze(value);
  weakSetAdd(AUTHENTIC_SHADOW_PROJECTIONS, frozen);
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
    if (error && error.code === 'EMAIL_LUNA_AUTOMATION_SHADOW_INVALID') throw error;
    throw invalid();
  }
}

function data(value, keys, exact) {
  if (!value || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)
      || objectGetPrototypeOf(value) !== objectPrototype) return null;
  let own;
  try { own = reflectOwnKeys(value); } catch (_) { return null; }
  if (arraySome(own, (key) => typeof key !== 'string' || !arrayIncludes(keys, key))
      || (exact && own.length !== keys.length)) return null;
  const out = objectCreate(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (!descriptor) { if (exact) return null; continue; }
    if (!objectHasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
    out[key] = descriptor.value;
  }
  return out;
}

function parseUuidRequired(raw) {
  if (raw === null || raw === undefined) throw invalid();
  const text = typeof raw === 'string' ? raw : (typeof raw === 'object' && raw && typeof raw.toString === 'function' ? raw.toString() : null);
  if (typeof text !== 'string') throw invalid();
  const id = stringToLowerCase(text);
  if (!regexpTest(UUID_CANON, id) || stringTrim(text) !== text) throw invalid();
  return id;
}

function isEmailLunaAutomationShadowEnabled(input) {
  const request = data(input, ENABLED_INPUT_KEYS, true);
  if (!request) return false;
  const env = data(request.env, ENV_KEYS, true);
  const gate = data(request.tenant_location_gate, GATE_KEYS, true);
  const authority = data(request.authority, AUTHORITY_KEYS, true);
  return Boolean(env && gate && authority
    && env.LUNA_DEPLOYMENT === SUNSET_DEPLOYMENT
    && env[ENV_SHADOW_ENABLED] === 'true'
    && gate.shadow_enabled === true
    && gate.location_key === SUNSET_LOCATION_KEY
    && authority.location_key === SUNSET_LOCATION_KEY
    && typeof authority.client_id === 'string' && typeof authority.location_id === 'string'
    && gate.client_id === authority.client_id && gate.location_id === authority.location_id
    && gate.location_key === authority.location_key);
}

function assertEmailLunaAutomationShadowProjection(value) {
  if (value === null || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)) throw invalid();
  if (!weakSetHas(AUTHENTIC_SHADOW_PROJECTIONS, value) || !objectIsFrozen(value)) throw invalid();
  if (objectGetPrototypeOf(value) !== null) throw invalid();
  if (value.send_allowed !== false || value.auto_send_allowed !== false) throw invalid();
  if (value.provider_invoked !== false || value.mode !== SHADOW_MODE) throw invalid();
  if (value.draft_only !== true || value.requires_staff_review !== true) throw invalid();
  return value;
}

function refuseForbiddenKeys(value) {
  const ownKeys = safeOwnKeys(value);
  for (let index = 0; index < ownKeys.length; index += 1) {
    if (arrayIncludes(FORBIDDEN_INPUT_KEYS, ownKeys[index])) throw invalid();
  }
}

function classifyInput(value) {
  refuseForbiddenKeys(value);
  const ownKeys = safeOwnKeys(value);
  if (ownKeys.length === READY_KEYS.length) return exactPlain(value, READY_KEYS);
  if (ownKeys.length === BASE_KEYS.length) return exactPlain(value, BASE_KEYS);
  throw invalid();
}

function readEnvelopeAuthority(envelope) {
  let binding;
  try {
    binding = createEmailLunaDraftHandoff({ envelope, reason: 'authority_mismatch' });
  } catch (_) {
    throw invalid();
  }
  const authority = envelope && envelope.authority;
  if (!authority || typeof authority !== 'object' || runtimeIsProxy(authority)) throw invalid();
  const locationKey = objectGetOwnPropertyDescriptor(authority, 'location_key');
  if (!locationKey || locationKey.value !== SUNSET_LOCATION_KEY) throw invalid();
  return freeze({
    client_id: parseUuidRequired(binding.client_id),
    location_id: parseUuidRequired(binding.location_id),
    conversation_id: parseUuidRequired(binding.conversation_id),
    location_key: SUNSET_LOCATION_KEY,
  });
}

function project(fields) {
  return output([
    ['status', fields.status],
    ['reason', fields.reason],
    ['mode', SHADOW_MODE],
    ['policy_version', DRAFT_POLICY_VERSION],
    ['eligibility_policy_version', ELIGIBILITY_POLICY_VERSION],
    ['canonical_status', fields.canonical_status],
    ['eligibility_status', fields.eligibility_status],
    ['state', fields.state],
    ['operation_id', fields.operation_id],
    ['issuance_id', fields.issuance_id],
    ['client_id', fields.client_id],
    ['location_id', fields.location_id],
    ['conversation_id', fields.conversation_id],
    ['draft_only', true],
    ['requires_staff_review', true],
    ['send_allowed', false],
    ['auto_send_allowed', false],
    ['provider_invoked', false],
  ]);
}

function wouldNotSend(authority, operationId, extra) {
  return project({
    status: 'would_not_send',
    reason: extra.reason,
    canonical_status: extra.canonical_status,
    eligibility_status: extra.eligibility_status,
    state: extra.state,
    operation_id: operationId,
    issuance_id: extra.issuance_id,
    client_id: authority.client_id,
    location_id: authority.location_id,
    conversation_id: authority.conversation_id,
  });
}

function createEmailLunaAutomationShadowOrchestrator(dependencies) {
  if (arguments.length !== 1) throw invalid();
  const deps = exactPlain(dependencies, FACTORY_KEYS);
  const withTransactionClient = deps.withTransactionClient;
  if (typeof withTransactionClient !== 'function' || runtimeIsProxy(withTransactionClient)) throw invalid();
  const env = exactPlain(deps.env, ENV_KEYS);
  const gate = exactPlain(deps.tenant_location_gate, GATE_KEYS);
  const gateClient = parseUuidRequired(gate.client_id);
  const gateLocation = parseUuidRequired(gate.location_id);
  if (env.LUNA_DEPLOYMENT !== SUNSET_DEPLOYMENT
      || env[ENV_SHADOW_ENABLED] !== 'true'
      || gate.shadow_enabled !== true
      || gate.location_key !== SUNSET_LOCATION_KEY) {
    throw disabledError();
  }

  const auditStore = createEmailLunaPolicyAuditStore({
    withTransactionClient,
    schemaVersion: EMAIL_LUNA_POLICY_AUDIT_SCHEMA_086,
  });
  const materialStore = createEmailLunaAutomationIssuanceMaterialStore({
    withTransactionClient,
  });
  if (!auditStore || typeof auditStore.persistPolicyAudit !== 'function') throw invalid();
  if (!materialStore || typeof materialStore.persistAndEnqueueAutomationIssuance !== 'function') throw invalid();

  async function persistAuditSafe(record) {
    try {
      return await auditStore.persistPolicyAudit(record);
    } catch (_) {
      return freeze({ status: 'unavailable' });
    }
  }

  async function persistQueueSafe(record) {
    try {
      return await materialStore.persistAndEnqueueAutomationIssuance(record);
    } catch (_) {
      return freeze({ status: 'unavailable' });
    }
  }

  async function orchestrateShadowDecision(input) {
    if (arguments.length !== 1) throw invalid();
    const request = classifyInput(input);
    const operationId = parseUuidRequired(request.operation_id);
    const authority = readEnvelopeAuthority(request.envelope);
    if (authority.client_id !== gateClient
        || authority.location_id !== gateLocation
        || authority.location_key !== SUNSET_LOCATION_KEY) {
      return wouldNotSend(authority, operationId, {
        reason: 'authority_mismatch',
        canonical_status: 'handoff_required',
        eligibility_status: 'handoff_required',
        state: 'not_queued',
        issuance_id: null,
      });
    }

    let eligibility;
    try {
      eligibility = decideEmailLunaAutonomousEligibility({
        envelope: request.envelope,
        evidence: request.evidence,
        decision: request.decision,
      });
    } catch (_) {
      return wouldNotSend(authority, operationId, {
        reason: 'unissued_evidence',
        canonical_status: 'handoff_required',
        eligibility_status: 'handoff_required',
        state: 'not_queued',
        issuance_id: null,
      });
    }

    let issuanceId = null;
    try {
      issuanceId = readEmailLunaDraftPolicyIssuanceIdentity(request.evidence);
    } catch (_) {
      issuanceId = null;
    }

    let trusted = null;
    try {
      trusted = assertEmailLunaDraftPolicyIssuance({
        envelope: request.envelope,
        evidence: request.evidence,
        decision: request.decision,
      });
    } catch (_) {
      trusted = null;
    }

    if (!trusted) {
      return wouldNotSend(authority, operationId, {
        reason: 'unissued_evidence',
        canonical_status: 'handoff_required',
        eligibility_status: 'handoff_required',
        state: 'not_queued',
        issuance_id: issuanceId,
      });
    }

    const canonicalStatus = trusted.status;
    const readyInput = objectHasOwn(request, 'draft') && objectHasOwn(request, 'validation');

    if (eligibility.status === 'handoff_required') {
      const audit = await persistAuditSafe({
        operation_id: operationId,
        envelope: request.envelope,
        evidence: request.evidence,
        decision: request.decision,
        eligibility,
      });
      const state = audit.status === 'committed' || audit.status === 'replayed' ? 'not_queued' : 'conflict';
      return wouldNotSend(authority, operationId, {
        reason: eligibility.reason,
        canonical_status: canonicalStatus,
        eligibility_status: 'handoff_required',
        state,
        issuance_id: issuanceId,
      });
    }

    if (eligibility.status !== 'eligible' || canonicalStatus !== 'draft_ready') {
      return wouldNotSend(authority, operationId, {
        reason: 'unsupported_intent',
        canonical_status: canonicalStatus,
        eligibility_status: eligibility.status,
        state: 'not_queued',
        issuance_id: issuanceId,
      });
    }

    if (!readyInput) {
      const audit = await persistAuditSafe({
        operation_id: operationId,
        envelope: request.envelope,
        evidence: request.evidence,
        decision: request.decision,
        eligibility,
      });
      const state = audit.status === 'committed' || audit.status === 'replayed' ? 'not_queued' : 'conflict';
      return wouldNotSend(authority, operationId, {
        reason: null,
        canonical_status: 'draft_ready',
        eligibility_status: 'eligible',
        state,
        issuance_id: issuanceId,
      });
    }

    const audit = await persistAuditSafe({
      operation_id: operationId,
      envelope: request.envelope,
      evidence: request.evidence,
      decision: request.decision,
      eligibility,
    });
    if (audit.status !== 'committed' && audit.status !== 'replayed') {
      return wouldNotSend(authority, operationId, {
        reason: null,
        canonical_status: 'draft_ready',
        eligibility_status: 'eligible',
        state: 'conflict',
        issuance_id: issuanceId,
      });
    }

    const persisted = await persistQueueSafe({
      operation_id: operationId,
      audit_operation_id: operationId,
      envelope: request.envelope,
      evidence: request.evidence,
      decision: request.decision,
      eligibility,
      draft: request.draft,
      validation: request.validation,
    });
    if ((persisted.status !== 'committed' && persisted.status !== 'replayed')
        || !persisted.record || persisted.record.state !== 'pending') {
      return wouldNotSend(authority, operationId, {
        reason: null,
        canonical_status: 'draft_ready',
        eligibility_status: 'eligible',
        state: 'conflict',
        issuance_id: issuanceId,
      });
    }
    if (parseUuidRequired(persisted.record.operation_id) !== operationId
        || parseUuidRequired(persisted.record.issuance_id) !== issuanceId
        || parseUuidRequired(persisted.record.client_id) !== authority.client_id
        || parseUuidRequired(persisted.record.location_id) !== authority.location_id
        || parseUuidRequired(persisted.record.conversation_id) !== authority.conversation_id) {
      return wouldNotSend(authority, operationId, {
        reason: 'authority_mismatch',
        canonical_status: 'draft_ready',
        eligibility_status: 'eligible',
        state: 'conflict',
        issuance_id: issuanceId,
      });
    }

    return project({
      status: 'would_send',
      reason: null,
      canonical_status: 'draft_ready',
      eligibility_status: 'eligible',
      state: persisted.status === 'replayed' ? 'replayed' : 'pending',
      operation_id: operationId,
      issuance_id: issuanceId,
      client_id: authority.client_id,
      location_id: authority.location_id,
      conversation_id: authority.conversation_id,
    });
  }

  return freeze({
    orchestrateShadowDecision,
  });
}

module.exports = objectFreeze({
  createEmailLunaAutomationShadowOrchestrator,
  isEmailLunaAutomationShadowEnabled,
  assertEmailLunaAutomationShadowProjection,
  EMAIL_LUNA_AUTOMATION_SHADOW_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_LOGGING_FORBIDDEN,
  ENV_SHADOW_ENABLED,
  SUNSET_DEPLOYMENT,
  SUNSET_LOCATION_KEY,
  SHADOW_MODE,
});
