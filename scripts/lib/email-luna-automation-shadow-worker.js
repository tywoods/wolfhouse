'use strict';

/**
 * FULL SAIL Stage 1 NIGHTWATCH Ch4 Slice B3: provider-inert shadow worker kernel
 * and optional default-off loop.
 *
 * Claims through the canonical queue owner, loads/recovers authentic issuance
 * material, revalidates Sunset gate/authority/eligibility, and returns shadow
 * comparison evidence. Success is NONTERMINAL (row stays claimed, no journal).
 * Recovery/material/authority failure uses require_handoff_claimed. Next-claim
 * skips attempt-capped expired rows via the existing claim owner. Never journals,
 * never sends, never treats the projection as send authority.
 */

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);
const { createEmailLunaAutomationQueueStore } = require('./email-luna-automation-queue-store');
const {
  createEmailLunaAutomationIssuanceMaterialStore,
  assertEmailLunaDraftPolicyIssuance,
  EMAIL_LUNA_DRAFT_POLICY_VERSION,
} = require('./email-luna-draft-policy');
const {
  decideEmailLunaAutonomousEligibility,
  EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION,
} = require('./email-luna-autonomous-eligibility-policy');
const { EMAIL_LUNA_DRAFT_VALIDATOR_VERSION } = require('./email-luna-draft-validator');

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

const AUTHENTIC_WORKER_EVIDENCE = new WeakSet();
const EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED = false;
const EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_LOGGING_FORBIDDEN = true;
const EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONCURRENCY = 1;
const EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_MIN_INTERVAL_MS = 60000;
const EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_MAX_INTERVAL_MS = 120000;
const ENV_SHADOW_WORKER_ENABLED = 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_ENABLED';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const SUNSET_LOCATION_KEY = 'sunset-somo';
const SHADOW_MODE = 'shadow';
const DRAFT_POLICY_VERSION = EMAIL_LUNA_DRAFT_POLICY_VERSION;
const ELIGIBILITY_POLICY_VERSION = EMAIL_LUNA_AUTONOMOUS_ELIGIBILITY_POLICY_VERSION;
const VALIDATOR_VERSION = EMAIL_LUNA_DRAFT_VALIDATOR_VERSION;

const KERNEL_KEYS = objectFreeze(['withTransactionClient', 'env', 'tenant_location_gate', 'owner_token']);
const LOOP_KEYS = objectFreeze(['kernel', 'timers', 'intervalMs']);
const ENV_KEYS = objectFreeze(['LUNA_DEPLOYMENT', ENV_SHADOW_WORKER_ENABLED]);
const GATE_KEYS = objectFreeze(['client_id', 'location_id', 'location_key', 'shadow_enabled']);
const ENABLED_INPUT_KEYS = objectFreeze(['env', 'tenant_location_gate', 'authority']);
const AUTHORITY_KEYS = objectFreeze(['client_id', 'location_id', 'location_key']);
const TIMER_KEYS = objectFreeze(['setTimeout', 'clearTimeout']);
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

const FORBIDDEN_INPUT_KEYS = objectFreeze([
  'status', 'would_send', 'would_not_send', 'send', 'provider', 'callback', 'onSend',
  'authorize_dispatch', 'authorize_create', 'authorize_update', 'claim', 'handoff',
  'client_id', 'location_id', 'recipient_address', 'recipient', 'capability',
  'facts', 'tenant', 'mode', 'send_allowed', 'auto_send_allowed', 'provider_invoked',
  'operation_id', 'issuance_id', 'conversation_id', 'endpoint_id', 'inbound_event_id',
]);

function invalid() {
  const error = new Error('Email Luna automation shadow worker failed.');
  error.code = 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_INVALID';
  return error;
}

function disabledError() {
  const error = new Error('Email Luna automation shadow worker disabled.');
  error.code = 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_DISABLED';
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
  weakSetAdd(AUTHENTIC_WORKER_EVIDENCE, frozen);
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
    if (error && error.code === 'EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_INVALID') throw error;
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

function refuseForbiddenKeys(value) {
  const ownKeys = safeOwnKeys(value);
  for (let index = 0; index < ownKeys.length; index += 1) {
    if (arrayIncludes(FORBIDDEN_INPUT_KEYS, ownKeys[index])) throw invalid();
  }
}

function isEmailLunaAutomationShadowWorkerEnabled(input) {
  const request = data(input, ENABLED_INPUT_KEYS, true);
  if (!request) return false;
  const env = data(request.env, ENV_KEYS, true);
  const gate = data(request.tenant_location_gate, GATE_KEYS, true);
  const authority = data(request.authority, AUTHORITY_KEYS, true);
  return Boolean(env && gate && authority
    && env.LUNA_DEPLOYMENT === SUNSET_DEPLOYMENT
    && env[ENV_SHADOW_WORKER_ENABLED] === 'true'
    && gate.shadow_enabled === true
    && gate.location_key === SUNSET_LOCATION_KEY
    && authority.location_key === SUNSET_LOCATION_KEY
    && typeof authority.client_id === 'string' && typeof authority.location_id === 'string'
    && gate.client_id === authority.client_id && gate.location_id === authority.location_id
    && gate.location_key === authority.location_key);
}

function assertEmailLunaAutomationShadowWorkerEvidence(value) {
  if (value === null || typeof value !== 'object' || runtimeIsProxy(value) || arrayIsArray(value)) throw invalid();
  if (!weakSetHas(AUTHENTIC_WORKER_EVIDENCE, value) || !objectIsFrozen(value)) throw invalid();
  if (objectGetPrototypeOf(value) !== null) throw invalid();
  if (value.send_allowed !== false || value.auto_send_allowed !== false) throw invalid();
  if (value.provider_invoked !== false || value.mode !== SHADOW_MODE) throw invalid();
  if (value.draft_only !== true || value.requires_staff_review !== true) throw invalid();
  if (value.journal_handoff !== false || value.provider_transition !== false) throw invalid();
  return value;
}

function evidence(fields) {
  return output([
    ['status', fields.status],
    ['reason', fields.reason],
    ['mode', SHADOW_MODE],
    ['policy_version', DRAFT_POLICY_VERSION],
    ['eligibility_policy_version', ELIGIBILITY_POLICY_VERSION],
    ['validator_version', VALIDATOR_VERSION],
    ['canonical_status', fields.canonical_status],
    ['eligibility_status', fields.eligibility_status],
    ['state', fields.state],
    ['terminal', fields.terminal === true],
    ['operation_id', fields.operation_id],
    ['issuance_id', fields.issuance_id],
    ['client_id', fields.client_id],
    ['location_id', fields.location_id],
    ['conversation_id', fields.conversation_id],
    ['lease_owner', fields.lease_owner],
    ['attempt_count', fields.attempt_count],
    ['draft_only', true],
    ['requires_staff_review', true],
    ['send_allowed', false],
    ['auto_send_allowed', false],
    ['provider_invoked', false],
    ['journal_handoff', false],
    ['provider_transition', false],
  ]);
}

function idleEvidence(status, reason) {
  return evidence({
    status,
    reason,
    canonical_status: null,
    eligibility_status: null,
    state: 'not_claimed',
    terminal: false,
    operation_id: null,
    issuance_id: null,
    client_id: null,
    location_id: null,
    conversation_id: null,
    lease_owner: null,
    attempt_count: null,
  });
}

function fromClaimed(record, extra) {
  return evidence({
    status: extra.status,
    reason: extra.reason,
    canonical_status: extra.canonical_status,
    eligibility_status: extra.eligibility_status,
    state: extra.state || record.state,
    terminal: extra.terminal === true,
    operation_id: record.operation_id,
    issuance_id: record.issuance_id,
    client_id: record.client_id,
    location_id: record.location_id,
    conversation_id: record.conversation_id,
    lease_owner: record.lease_owner,
    attempt_count: record.attempt_count,
  });
}

function bindMatches(record, gate, ownerToken) {
  return record.client_id === gate.client_id
    && record.location_id === gate.location_id
    && record.location_key === gate.location_key
    && record.lease_owner === ownerToken
    && record.state === 'claimed'
    && record.handoff_id === null;
}

function recoveredMatches(record, recovered, loaded, gate) {
  if (!recovered || recovered.status !== 'recovered' || !recovered.record) return false;
  const recoveredRecord = recovered.record;
  if (recoveredRecord.operation_id !== record.operation_id) return false;
  if (recoveredRecord.issuance_id !== record.issuance_id) return false;
  if (recoveredRecord.draft_digest !== record.draft_digest) return false;
  if (typeof recoveredRecord.draft_digest !== 'string' || !regexpTest(DIGEST_RE, recoveredRecord.draft_digest)) return false;
  if (loaded.queue_state !== 'claimed') return false;
  if (loaded.operation_id !== record.operation_id || loaded.issuance_id !== record.issuance_id) return false;
  if (loaded.client_id !== gate.client_id || loaded.location_id !== gate.location_id) return false;
  if (loaded.location_key !== SUNSET_LOCATION_KEY) return false;
  if (loaded.conversation_id !== record.conversation_id) return false;
  if (loaded.endpoint_id !== record.endpoint_id) return false;
  if (loaded.inbound_event_id !== record.inbound_event_id) return false;
  if (loaded.recipient_address !== record.recipient_address) return false;
  if (loaded.audit_operation_id !== record.audit_operation_id) return false;
  return true;
}

function createEmailLunaAutomationShadowWorkerKernel(dependencies) {
  if (arguments.length !== 1) throw invalid();
  refuseForbiddenKeys(dependencies);
  const deps = exactPlain(dependencies, KERNEL_KEYS);
  const withTransactionClient = deps.withTransactionClient;
  if (typeof withTransactionClient !== 'function' || runtimeIsProxy(withTransactionClient)) throw invalid();
  const env = exactPlain(deps.env, ENV_KEYS);
  const gate = exactPlain(deps.tenant_location_gate, GATE_KEYS);
  const gateClient = parseUuidRequired(gate.client_id);
  const gateLocation = parseUuidRequired(gate.location_id);
  const ownerToken = parseUuidRequired(deps.owner_token);
  if (env.LUNA_DEPLOYMENT !== SUNSET_DEPLOYMENT
      || env[ENV_SHADOW_WORKER_ENABLED] !== 'true'
      || gate.shadow_enabled !== true
      || gate.location_key !== SUNSET_LOCATION_KEY) {
    throw disabledError();
  }
  const boundGate = freeze({
    client_id: gateClient,
    location_id: gateLocation,
    location_key: SUNSET_LOCATION_KEY,
  });

  const queueStore = createEmailLunaAutomationQueueStore({ withTransactionClient });
  const materialStore = createEmailLunaAutomationIssuanceMaterialStore({ withTransactionClient });
  if (!queueStore || typeof queueStore.claimAutomationOperation !== 'function') throw invalid();
  if (typeof queueStore.requireHandoffAutomationOperation !== 'function') throw invalid();
  if (typeof queueStore.cancelAutomationOperation !== 'function') throw invalid();
  if (!materialStore || typeof materialStore.loadAutomationIssuanceMaterial !== 'function') throw invalid();
  if (typeof materialStore.recoverAutomationIssuance !== 'function') throw invalid();

  let stopped = false;

  function requestStop() {
    stopped = true;
  }

  function resume() {
    stopped = false;
  }

  async function failClosedClaimed(record, reason) {
    let required;
    try {
      required = await queueStore.requireHandoffAutomationOperation({
        operation_id: record.operation_id,
        owner_token: ownerToken,
      });
    } catch (_) {
      return fromClaimed(record, {
        status: 'conflict',
        reason: 'stale_lease',
        canonical_status: null,
        eligibility_status: null,
        state: record.state,
        terminal: false,
      });
    }
    if (required.status === 'handoff_required' && required.record) {
      return fromClaimed(required.record, {
        status: 'would_not_send',
        reason,
        canonical_status: 'handoff_required',
        eligibility_status: 'handoff_required',
        state: 'handoff_required',
        terminal: true,
      });
    }
    return fromClaimed(record, {
      status: 'conflict',
      reason: 'stale_lease',
      canonical_status: null,
      eligibility_status: null,
      state: record.state,
      terminal: false,
    });
  }

  async function processNextShadowClaim() {
    if (arguments.length !== 0) throw invalid();
    if (stopped) return idleEvidence('stopped', 'stop_requested');

    let claimed;
    try {
      claimed = await queueStore.claimAutomationOperation({ owner_token: ownerToken });
    } catch (_) {
      throw invalid();
    }
    if (stopped) {
      if (claimed && claimed.status === 'claimed' && claimed.record) {
        return fromClaimed(claimed.record, {
          status: 'stopped',
          reason: 'stop_requested',
          canonical_status: null,
          eligibility_status: null,
          state: claimed.record.state,
          terminal: false,
        });
      }
      return idleEvidence('stopped', 'stop_requested');
    }
    if (!claimed || typeof claimed !== 'object') throw invalid();
    if (claimed.status === 'empty') return idleEvidence('empty', null);
    if (claimed.status === 'attempt_cap' && claimed.record) {
      return fromClaimed(claimed.record, {
        status: 'attempt_cap',
        reason: 'attempt_cap',
        canonical_status: 'handoff_required',
        eligibility_status: 'handoff_required',
        state: claimed.record.state,
        terminal: true,
      });
    }
    if (claimed.status === 'conflict') {
      return idleEvidence('conflict', 'non_claimed_state');
    }
    if (claimed.status !== 'claimed' || !claimed.record) throw invalid();
    const record = claimed.record;
    if (!bindMatches(record, boundGate, ownerToken)) {
      return failClosedClaimed(record, 'authority_mismatch');
    }

    let loaded;
    try {
      loaded = await materialStore.loadAutomationIssuanceMaterial({
        operation_id: record.operation_id,
        issuance_id: record.issuance_id,
      });
    } catch (_) {
      return failClosedClaimed(record, 'recovery_mismatch');
    }
    if (!loaded || loaded.status !== 'loaded' || !loaded.record) {
      return failClosedClaimed(record, 'material_missing');
    }

    let recovered;
    try {
      recovered = materialStore.recoverAutomationIssuance({ material: loaded.record });
    } catch (_) {
      return failClosedClaimed(record, 'recovery_mismatch');
    }
    if (!recoveredMatches(record, recovered, loaded.record, boundGate)) {
      return failClosedClaimed(record, 'recovery_mismatch');
    }

    let trusted;
    try {
      trusted = assertEmailLunaDraftPolicyIssuance({
        envelope: recovered.record.envelope,
        evidence: recovered.record.evidence,
        decision: recovered.record.decision,
      });
    } catch (_) {
      return failClosedClaimed(record, 'unissued_evidence');
    }
    if (!trusted || trusted.status !== 'draft_ready') {
      return failClosedClaimed(record, 'unissued_evidence');
    }
    if (trusted.binding.client_id !== boundGate.client_id
        || trusted.binding.location_id !== boundGate.location_id
        || trusted.binding.conversation_id !== record.conversation_id
        || trusted.authority.location_key !== SUNSET_LOCATION_KEY
        || trusted.authority.endpoint_id !== record.endpoint_id) {
      return failClosedClaimed(record, 'authority_mismatch');
    }

    let eligibility;
    try {
      eligibility = decideEmailLunaAutonomousEligibility({
        envelope: recovered.record.envelope,
        evidence: recovered.record.evidence,
        decision: recovered.record.decision,
      });
    } catch (_) {
      return failClosedClaimed(record, 'unissued_evidence');
    }
    if (!eligibility || eligibility.status !== 'eligible') {
      return failClosedClaimed(record, eligibility && eligibility.reason ? eligibility.reason : 'eligibility_handoff');
    }
    if (recovered.record.validation.status !== 'valid') {
      return failClosedClaimed(record, 'recovery_mismatch');
    }

    return fromClaimed(record, {
      status: 'would_send',
      reason: null,
      canonical_status: 'draft_ready',
      eligibility_status: 'eligible',
      state: 'claimed',
      terminal: false,
    });
  }

  return freeze({
    processNextShadowClaim,
    requestStop,
    resume,
  });
}

function createEmailLunaAutomationShadowWorkerLoop(dependencies) {
  if (arguments.length !== 1) throw invalid();
  refuseForbiddenKeys(dependencies);
  const deps = exactPlain(dependencies, LOOP_KEYS);
  const kernel = deps.kernel;
  if (!kernel || typeof kernel !== 'object' || runtimeIsProxy(kernel) || arrayIsArray(kernel)) throw invalid();
  if (typeof kernel.processNextShadowClaim !== 'function' || runtimeIsProxy(kernel.processNextShadowClaim)) throw invalid();
  if (typeof kernel.requestStop !== 'function' || typeof kernel.resume !== 'function') throw invalid();
  const timers = exactPlain(deps.timers, TIMER_KEYS);
  if (typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') throw invalid();
  if (runtimeIsProxy(timers.setTimeout) || runtimeIsProxy(timers.clearTimeout)) throw invalid();
  const intervalMs = deps.intervalMs;
  if (!Number.isInteger(intervalMs)
      || intervalMs < EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_MIN_INTERVAL_MS
      || intervalMs > EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_MAX_INTERVAL_MS) {
    throw invalid();
  }

  let running = false;
  let timer = null;
  let stopped = true;

  async function tick() {
    if (arguments.length !== 0) throw invalid();
    if (stopped) return idleEvidence('stopped', 'stop_requested');
    if (running) return idleEvidence('overlap_skipped', null);
    running = true;
    try {
      return await kernel.processNextShadowClaim();
    } finally {
      running = false;
    }
  }

  function arm() {
    if (stopped) return;
    timer = timers.setTimeout(async () => {
      try {
        await tick();
      } catch (_) {
        /* logging forbidden */
      } finally {
        arm();
      }
    }, intervalMs);
  }

  function start() {
    if (!stopped) return;
    kernel.resume();
    stopped = false;
    arm();
  }

  function stop() {
    stopped = true;
    kernel.requestStop();
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  }

  return freeze({
    tick,
    start,
    stop,
  });
}

module.exports = objectFreeze({
  createEmailLunaAutomationShadowWorkerKernel,
  createEmailLunaAutomationShadowWorkerLoop,
  isEmailLunaAutomationShadowWorkerEnabled,
  assertEmailLunaAutomationShadowWorkerEvidence,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_RUNTIME_WIRED,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_LOGGING_FORBIDDEN,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_CONCURRENCY,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_MIN_INTERVAL_MS,
  EMAIL_LUNA_AUTOMATION_SHADOW_WORKER_MAX_INTERVAL_MS,
  ENV_SHADOW_WORKER_ENABLED,
  SUNSET_DEPLOYMENT,
  SUNSET_LOCATION_KEY,
  SHADOW_MODE,
});
