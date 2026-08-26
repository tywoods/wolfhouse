'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4I — closed capability
 * store. Import-inert. Does not call Azure/KV/PG/Microsoft/JWKS/Graph.
 * Does not flip Chapter 4E/4G/4H LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER.
 *
 * Public enumerable exports are error identity and chapter constants only.
 * Mint/consume/predicate functions are not enumerable and are refused to
 * any caller that is not the exact lexical production file allowed to use
 * them. Importing this module cannot authorize 4H adapters or 4G compose.
 *
 * @module email-luna-controlled-drafting-chapter-4i-one-shot-authority
 */

const fs = require('node:fs');
const path = require('node:path');
const { isProxySurface, ownData, isCanonUuid } = require('./email-luna-controlled-drafting-closed-data');

const objectFreeze = Object.freeze;
const objectCreate = Object.create;
const arrayIsArray = Array.isArray;

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_CHAPTER_4I_LIVE_EXECUTION_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting Chapter 4I live execution failed.';
const CHAPTER_ID = 'chapter_4i';
const DETAIL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const SHA40_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

const OWNED_4I = 'email-luna-controlled-drafting-sunset-staging-live-execution-owner-owned.js';
const OWNED_4H = 'email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader-owned.js';
const LIVE_TARGET = 'email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target.js';

const READ_CAPS = new WeakSet();
const COMPOSE_CAPS = new WeakSet();
const COMPOSE_BINDINGS = new WeakMap();

const state = {
  readMinted: false,
  composeMinted: false,
};

function failure(code) {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  if (typeof code === 'string' && DETAIL_RE.test(code)) error.detail = code;
  objectFreeze(error);
  return error;
}

function authenticLibCaller(allowedBasenames) {
  const libDir = fs.realpathSync(__dirname);
  const self = fs.realpathSync(__filename);
  const previous = Error.prepareStackTrace;
  let stack;
  try {
    Error.prepareStackTrace = (_, frames) => frames;
    const err = new Error();
    Error.captureStackTrace(err, authenticLibCaller);
    stack = err.stack;
  } catch (_) {
    return false;
  } finally {
    Error.prepareStackTrace = previous;
  }
  if (!arrayIsArray(stack) || stack.length < 1) return false;
  for (let i = 0; i < stack.length; i += 1) {
    const frame = stack[i];
    if (!frame || typeof frame.getFileName !== 'function') continue;
    const file = frame.getFileName();
    if (typeof file !== 'string' || file.length < 1) continue;
    let real;
    try {
      real = fs.realpathSync(file);
    } catch (_) {
      continue;
    }
    if (real === self) continue;
    if (path.dirname(real) !== libDir) return false;
    return allowedBasenames.indexOf(path.basename(real)) !== -1;
  }
  return false;
}

function requireSha40(value) {
  return typeof value === 'string' && SHA40_RE.test(value);
}

function requireDigest(value) {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function requireHex64(value) {
  return typeof value === 'string' && HEX64_RE.test(value);
}

function requireGeneration(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function snapshotComposeBinding(evidence) {
  if (!evidence || (typeof evidence !== 'object' && typeof evidence !== 'function') || isProxySurface(evidence)) {
    return null;
  }
  const deploySha = ownData(evidence, 'deploy_sha');
  const revision = ownData(evidence, 'revision');
  const digest = ownData(evidence, 'digest');
  const generation = ownData(evidence, 'grant_generation');
  const clientId = ownData(evidence, 'client_id');
  const locationId = ownData(evidence, 'location_id');
  const endpointId = ownData(evidence, 'endpoint_id');
  const mailboxId = ownData(evidence, 'mailbox_id');
  const producerFp = ownData(evidence, 'producer_login_fingerprint');
  const workerFp = ownData(evidence, 'worker_login_fingerprint');
  const subscriptionId = ownData(evidence, 'subscription_id');
  const resourceGroup = ownData(evidence, 'resource_group');
  const appName = ownData(evidence, 'app_name');
  const tenant = ownData(evidence, 'tenant');
  const database = ownData(evidence, 'database');
  if (!requireSha40(deploySha) || typeof revision !== 'string' || !requireDigest(digest)) return null;
  if (!requireGeneration(generation)) return null;
  if (!isCanonUuid(clientId) || !isCanonUuid(locationId) || !isCanonUuid(endpointId) || !isCanonUuid(mailboxId)) {
    return null;
  }
  if (!requireHex64(producerFp) || !requireHex64(workerFp)) return null;
  if (typeof subscriptionId !== 'string' || typeof resourceGroup !== 'string' || typeof appName !== 'string') {
    return null;
  }
  if (typeof tenant !== 'string' || typeof database !== 'string') return null;
  return objectFreeze({
    deploy_sha: deploySha,
    revision,
    digest,
    grant_generation: generation,
    client_id: clientId,
    location_id: locationId,
    endpoint_id: endpointId,
    mailbox_id: mailboxId,
    producer_login_fingerprint: producerFp,
    worker_login_fingerprint: workerFp,
    subscription_id: subscriptionId,
    resource_group: resourceGroup,
    app_name: appName,
    tenant,
    database,
  });
}

function mintExactlyOneProductionReadCapability() {
  if (authenticLibCaller([OWNED_4I]) !== true) throw failure('capability_refused');
  if (state.readMinted === true) throw failure('one_shot_already_consumed');
  const cap = objectFreeze(objectCreate(null, {
    kind: { value: 'chapter_4i_production_read', enumerable: true },
  }));
  READ_CAPS.add(cap);
  state.readMinted = true;
  return cap;
}

function consumeProductionReadCapability(capability) {
  if (authenticLibCaller([OWNED_4H]) !== true) return false;
  try {
    if (!READ_CAPS.has(capability)) return false;
    READ_CAPS.delete(capability);
    return true;
  } catch (_) {
    return false;
  }
}

function mintExactlyOneComposeCapability(evidence) {
  if (authenticLibCaller([OWNED_4I]) !== true) throw failure('capability_refused');
  if (state.composeMinted === true) throw failure('one_shot_already_consumed');
  const binding = snapshotComposeBinding(evidence);
  if (!binding) throw failure('live_preflight_unproven');
  const cap = objectFreeze(objectCreate(null, {
    kind: { value: 'chapter_4i_canonical_compose', enumerable: true },
  }));
  COMPOSE_CAPS.add(cap);
  COMPOSE_BINDINGS.set(cap, binding);
  state.composeMinted = true;
  return cap;
}

function consumeComposeCapability(capability) {
  if (authenticLibCaller([LIVE_TARGET]) !== true) return false;
  try {
    if (!COMPOSE_CAPS.has(capability)) return false;
    COMPOSE_CAPS.delete(capability);
    const binding = COMPOSE_BINDINGS.get(capability);
    COMPOSE_BINDINGS.delete(capability);
    if (!binding) return false;
    return binding;
  } catch (_) {
    return false;
  }
}

const PUBLIC_KEYS = objectFreeze([
  'ERROR_CODE',
  'ERROR_MESSAGE',
  'CHAPTER_ID',
]);

const publicSurface = objectFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  CHAPTER_ID,
});

const hidden = objectFreeze({
  mintExactlyOneProductionReadCapability,
  consumeProductionReadCapability,
  mintExactlyOneComposeCapability,
  consumeComposeCapability,
});

const HIDDEN_BY_CALLER = objectFreeze({
  mintExactlyOneProductionReadCapability: objectFreeze([OWNED_4I]),
  consumeProductionReadCapability: objectFreeze([OWNED_4H]),
  mintExactlyOneComposeCapability: objectFreeze([OWNED_4I]),
  consumeComposeCapability: objectFreeze([LIVE_TARGET]),
});

module.exports = new Proxy(publicSurface, {
  get(target, prop) {
    if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(hidden, prop)) {
      if (authenticLibCaller(HIDDEN_BY_CALLER[prop]) !== true) return undefined;
      return hidden[prop];
    }
    return target[prop];
  },
  has(target, prop) {
    if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(hidden, prop)) return false;
    return Object.prototype.hasOwnProperty.call(target, prop);
  },
  ownKeys() {
    return PUBLIC_KEYS.slice();
  },
  getOwnPropertyDescriptor(target, prop) {
    if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(hidden, prop)) {
      return undefined;
    }
    return Object.getOwnPropertyDescriptor(target, prop);
  },
  set() {
    return false;
  },
  defineProperty() {
    return false;
  },
  deleteProperty() {
    return false;
  },
});
