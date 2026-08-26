'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4I — process-local
 * one-shot Sunset staging live-execution authority.
 *
 * Import-inert. Does not call Azure/KV/PG/Microsoft/JWKS/Graph. Does not
 * flip Chapter 4E/4G/4H `LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER`. Staff
 * API startup does not import this module.
 *
 * Authority is structural: WeakSet brand + explicit phase. Consumable
 * exactly once per process. A second consume fails closed. Caller
 * snapshots, env JSON, args, and files cannot mint this brand.
 *
 * @module email-luna-controlled-drafting-chapter-4i-one-shot-authority
 */

const { isProxySurface, ownData } = require('./email-luna-controlled-drafting-closed-data');

const objectFreeze = Object.freeze;
const objectCreate = Object.create;

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_CHAPTER_4I_LIVE_EXECUTION_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting Chapter 4I live execution failed.';
const AUTHORITIES = new WeakSet();
const DETAIL_RE = /^[a-z][a-z0-9_]{0,63}$/;

const PHASE = objectFreeze({
  idle: 'idle',
  one_shot_consumed: 'one_shot_consumed',
  preflight_branded: 'preflight_branded',
  executing: 'executing',
  terminal: 'terminal',
});

const state = {
  phase: PHASE.idle,
  brand: null,
  nonce: null,
};

function failure(code) {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  if (typeof code === 'string' && DETAIL_RE.test(code)) error.detail = code;
  objectFreeze(error);
  return error;
}

function isChapter4ISunsetStagingOneShotAuthority(value) {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
    if (isProxySurface(value)) return false;
    return AUTHORITIES.has(value) === true
      && ownData(value, 'kind') === 'chapter_4i_sunset_staging_one_shot';
  } catch (_) {
    return false;
  }
}

function isActiveChapter4ISunsetStagingOneShotAuthority() {
  try {
    if (state.phase === PHASE.idle || state.phase === PHASE.terminal) return false;
    return isChapter4ISunsetStagingOneShotAuthority(state.brand) === true;
  } catch (_) {
    return false;
  }
}

function isChapter4IBrandedPreflightPhase() {
  try {
    if (state.phase !== PHASE.preflight_branded && state.phase !== PHASE.executing) {
      return false;
    }
    return isChapter4ISunsetStagingOneShotAuthority(state.brand) === true;
  } catch (_) {
    return false;
  }
}

function consumeChapter4ISunsetStagingOneShotAuthority(input) {
  if (arguments.length > 1) throw failure('caller_input_refused');
  if (input !== undefined && input !== null) {
    if (!input || typeof input !== 'object' || isProxySurface(input)) {
      throw failure('caller_input_refused');
    }
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 1 || keys[0] !== 'operatorNonce') throw failure('caller_input_refused');
  }
  if (state.phase !== PHASE.idle || state.brand !== null) {
    throw failure('one_shot_already_consumed');
  }
  const nonce = input ? ownData(input, 'operatorNonce') : null;
  if (input && (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce))) {
    throw failure('operator_nonce_invalid');
  }
  if (typeof nonce === 'string' && state.nonce === nonce) {
    throw failure('operator_nonce_replay');
  }
  const brand = objectFreeze(objectCreate(null, {
    kind: { value: 'chapter_4i_sunset_staging_one_shot', enumerable: true },
  }));
  AUTHORITIES.add(brand);
  state.brand = brand;
  state.nonce = typeof nonce === 'string' ? nonce : null;
  state.phase = PHASE.one_shot_consumed;
  return brand;
}

function markChapter4IBrandedPreflight(brand) {
  if (isChapter4ISunsetStagingOneShotAuthority(brand) !== true) {
    throw failure('live_preflight_unproven');
  }
  if (state.brand !== brand || AUTHORITIES.has(brand) !== true) {
    throw failure('live_preflight_unproven');
  }
  if (state.phase !== PHASE.one_shot_consumed) {
    throw failure('one_shot_already_consumed');
  }
  state.phase = PHASE.preflight_branded;
  return true;
}

function markChapter4IExecuting() {
  if (isChapter4IBrandedPreflightPhase() !== true) {
    throw failure('live_preflight_unproven');
  }
  state.phase = PHASE.executing;
  return true;
}

function markChapter4ITerminal() {
  state.phase = PHASE.terminal;
  return true;
}

function readChapter4IOneShotPhase() {
  return state.phase;
}

module.exports = objectFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  PHASE,
  consumeChapter4ISunsetStagingOneShotAuthority,
  isChapter4ISunsetStagingOneShotAuthority,
  isActiveChapter4ISunsetStagingOneShotAuthority,
  isChapter4IBrandedPreflightPhase,
  markChapter4IBrandedPreflight,
  markChapter4IExecuting,
  markChapter4ITerminal,
  readChapter4IOneShotPhase,
});
