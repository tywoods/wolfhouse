'use strict';
/**
 * Gate 3 B3a1 — intent-disjoint shared OAuth callback dispatch.
 * Pure injected A/B factories; no routes/DB/SELECT/browser intent. Import-inert.
 * Pre-child frozen own-data snaps (descriptors only): reject Proxy/symbol/accessor/
 * nonplain/extras/hybrids. Query {state,code}[+session_state]|{state,error} (order ok).
 * Owner ordered {clientId,authSessionId} lowercase UUIDs; freeze fresh snap (caller
 * need not be frozen). Children parse values; no secret log. Invoke: Reflect.apply
 * raw before await; sync Proxy reject (zero traps); genuine native Promise
 * (util.types.isPromise, never [[Get]] then). Post-await frozen status via descriptors.
 * Unavoidable: Promise resolving a Proxy may [[Get]] then before dispatcher sees it.
 * @module email-microsoft-oauth-shared-callback-dispatch
 */
const util = require('util');
const { resolveOptionalStageTelemetry, safeEmitStage } = require('./email-microsoft-oauth-stage-telemetry');
const UT = util.types && typeof util.types === 'object' ? util.types : null;
const ISP = UT && typeof UT.isProxy === 'function' ? UT.isProxy : null;
const ISPROMISE = UT && typeof UT.isPromise === 'function' ? UT.isPromise : null;
const ERROR_CODE = 'MICROSOFT_OAUTH_SHARED_CALLBACK_DISPATCH_INVALID';
const ERROR_MESSAGE = 'Microsoft OAuth shared callback dispatch failed.';
const ACCEPT_METHOD = 'accept';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const PHASE_A_CALLBACK_ENABLED_ENV = 'LUNA_EMAIL_OAUTH_CALLBACK_ENABLED';
const PHASE_B_CALLBACK_ENABLED_ENV = 'LUNA_EMAIL_OAUTH_PHASE_B_CALLBACK_ENABLED';
const S_INVALID = 'invalid_or_expired';
const S_DECLINED = 'authorization_declined';
const S_RECEIVED = 'authorization_received';
const S_UNAVAILABLE = 'authorization_unavailable';
const S_OUTCOME = 'outcome_unknown';
const PUB_INVALID = Object.freeze({ status: S_INVALID });
const PUB_DECLINED = Object.freeze({ status: S_DECLINED });
const PUB_RECEIVED = Object.freeze({ status: S_RECEIVED });
const PUB_UNAVAILABLE = Object.freeze({ status: S_UNAVAILABLE });
const PUB_OUTCOME = Object.freeze({ status: S_OUTCOME });
const ALLOW = Object.freeze({
  [S_INVALID]: PUB_INVALID, [S_DECLINED]: PUB_DECLINED, [S_RECEIVED]: PUB_RECEIVED,
  [S_UNAVAILABLE]: PUB_UNAVAILABLE, [S_OUTCOME]: PUB_OUTCOME,
});
// B3a2b: route-wired/safe; deferred (flags default-off); import inert.
const EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_IMPORT_INERT = true;
const EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_RUNTIME_WIRED = true;
const EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_DEFERRED_ACTIVATION = true;
const EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_SAFE_FOR_RUNTIME_ROUTE = true;
const DEPENDENCY_KEYS = Object.freeze(['env', 'createPhaseACallback', 'createPhaseBCallback']);
const OWNER_KEYS = Object.freeze(['clientId', 'authSessionId']);
const Q_CODE_ALLOW = Object.freeze(new Set(['state', 'code', 'session_state']));
const Q_ERR_ALLOW = Object.freeze(new Set(['state', 'error']));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_RUNTIME_WIRED !== true
    || EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_DEFERRED_ACTIVATION !== true
    || EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_SAFE_FOR_RUNTIME_ROUTE !== true
    || EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_IMPORT_INERT !== true) {
  throw new Error('shared_oauth_callback_dispatch_activation_unexpected');
}
function failure() {
  const e = new Error(ERROR_MESSAGE);
  Object.defineProperty(e, 'name', { value: 'MicrosoftOauthSharedCallbackDispatchError' });
  Object.defineProperty(e, 'code', { value: ERROR_CODE, enumerable: true });
  return Object.freeze(e);
}
function isProxy(v) {
  try {
    if (typeof ISP !== 'function' || !UT) return true;
    return Reflect.apply(ISP, UT, [v]) === true;
  } catch { return true; }
}
function isNativePromise(v) {
  try {
    if (v == null || isProxy(v) || typeof ISPROMISE !== 'function' || !UT) return false;
    return Reflect.apply(ISPROMISE, UT, [v]) === true;
  } catch { return false; }
}
function own(o, k) {
  try {
    if (o == null || isProxy(o)) return undefined;
    const d = Object.getOwnPropertyDescriptor(o, k);
    return d && Object.prototype.hasOwnProperty.call(d, 'value') && !d.get && !d.set ? d.value : undefined;
  } catch { return undefined; }
}
function exactPlain(o, keys) {
  try {
    if (!o || isProxy(o) || Object.getPrototypeOf(o) !== Object.prototype) return false;
    const a = Reflect.ownKeys(o);
    if (a.length !== keys.length || a.some((k) => typeof k !== 'string' || !keys.includes(k))) return false;
    return keys.every((k) => {
      const d = Object.getOwnPropertyDescriptor(o, k);
      return d && Object.prototype.hasOwnProperty.call(d, 'value') && d.enumerable && !d.get && !d.set;
    });
  } catch { return false; }
}
function exactFrozen(o, keys) { return Boolean(o && Object.isFrozen(o) && exactPlain(o, keys)); }
function readOwnEnvString(env, key) {
  try {
    if (env == null || (typeof env !== 'object' && typeof env !== 'function') || isProxy(env)) return null;
    if (!Object.prototype.hasOwnProperty.call(env, key)) return { present: false };
    const d = Object.getOwnPropertyDescriptor(env, key);
    if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || !d.enumerable) return null;
    if (typeof d.value !== 'string') return null;
    return { present: true, value: d.value };
  } catch { return null; }
}
function readOwnEnvExactTrue(env, key) {
  try {
    if (env == null || (typeof env !== 'object' && typeof env !== 'function') || isProxy(env)) return null;
    if (!Object.prototype.hasOwnProperty.call(env, key)) return false;
    const d = Object.getOwnPropertyDescriptor(env, key);
    if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || !d.enumerable) return null;
    return d.value === 'true';
  } catch { return null; }
}
function snapGates(env) {
  try {
    if (!env || (typeof env !== 'object' && typeof env !== 'function') || isProxy(env)) return null;
    let oks; try { oks = Reflect.ownKeys(env); } catch { return null; }
    for (let i = 0; i < oks.length; i += 1) if (typeof oks[i] === 'symbol') return null;
    const dep = readOwnEnvString(env, 'LUNA_DEPLOYMENT');
    if (!dep || !dep.present || dep.value !== SUNSET_DEPLOYMENT) return null;
    const a = readOwnEnvExactTrue(env, PHASE_A_CALLBACK_ENABLED_ENV);
    const b = readOwnEnvExactTrue(env, PHASE_B_CALLBACK_ENABLED_ENV);
    if (a === null || b === null) return null;
    return Object.freeze({ phaseAEnabled: a === true, phaseBEnabled: b === true });
  } catch { return null; }
}
function dataOnce(o, k) {
  try {
    if (!o || isProxy(o)) return null;
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || !d.enumerable) return null;
    return { value: d.value };
  } catch { return null; }
}
function snapQuery(input) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return null;
    const pr = Object.getPrototypeOf(input);
    if (pr !== Object.prototype && pr !== null) return null;
    let keys; try { keys = Reflect.ownKeys(input); } catch { return null; }
    if (!keys.length) return null;
    const seen = new Set(); let c = 0; let e = 0; let s = 0; let ss = 0;
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      if (typeof k !== 'string' || seen.has(k)) return null;
      seen.add(k);
      if (k === 'code') c = 1; else if (k === 'error') e = 1; else if (k === 'state') s = 1;
      else if (k === 'session_state') ss = 1; else return null;
    }
    if (c && e) return null;
    if (c) {
      if (!s || seen.size < 2 || seen.size > 3) return null;
      for (const k of seen) if (!Q_CODE_ALLOW.has(k)) return null;
      const st = dataOnce(input, 'state'); const cd = dataOnce(input, 'code');
      if (!st || !cd) return null;
      if (ss) {
        const x = dataOnce(input, 'session_state'); if (!x) return null;
        return Object.freeze({ state: st.value, code: cd.value, session_state: x.value });
      }
      return Object.freeze({ state: st.value, code: cd.value });
    }
    if (e) {
      if (ss || !s || seen.size !== 2) return null;
      for (const k of seen) if (!Q_ERR_ALLOW.has(k)) return null;
      const st = dataOnce(input, 'state'); const er = dataOnce(input, 'error');
      if (!st || !er) return null;
      return Object.freeze({ state: st.value, error: er.value });
    }
    return null;
  } catch { return null; }
}
function snapOwner(owner) {
  try {
    if (!owner || typeof owner !== 'object' || Array.isArray(owner) || isProxy(owner)) return null;
    const pr = Object.getPrototypeOf(owner);
    if (pr !== Object.prototype && pr !== null) return null;
    const actual = Reflect.ownKeys(owner);
    if (actual.length !== OWNER_KEYS.length) return null;
    for (let i = 0; i < OWNER_KEYS.length; i += 1) if (actual[i] !== OWNER_KEYS[i]) return null;
    const out = {};
    for (const k of OWNER_KEYS) {
      const r = dataOnce(owner, k);
      if (!r || typeof r.value !== 'string' || !UUID_RE.test(r.value)) return null;
      out[k] = r.value.toLowerCase();
    }
    return Object.freeze({ clientId: out.clientId, authSessionId: out.authSessionId });
  } catch { return null; }
}
function mapPublicStatus(result) {
  try {
    if (!result || isProxy(result) || !Object.isFrozen(result)
        || Object.getPrototypeOf(result) !== Object.prototype) return null;
    if (Reflect.ownKeys(result).length !== 1 || Reflect.ownKeys(result)[0] !== 'status') return null;
    const d = Object.getOwnPropertyDescriptor(result, 'status');
    if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || !d.enumerable) return null;
    return typeof d.value === 'string' ? (ALLOW[d.value] || null) : null;
  } catch { return null; }
}
function pinDeps(deps) {
  try {
    if (!deps || isProxy(deps)) return null;
    const resolved = resolveOptionalStageTelemetry(deps, DEPENDENCY_KEYS);
    if (!resolved.ok || !resolved.stageTelemetry) return null;
    const createA = own(deps, 'createPhaseACallback');
    const createB = own(deps, 'createPhaseBCallback');
    if (typeof createA !== 'function' || isProxy(createA)
        || typeof createB !== 'function' || isProxy(createB)) return null;
    const gates = snapGates(own(deps, 'env'));
    if (!gates) return null;
    return Object.freeze({
      phaseAEnabled: gates.phaseAEnabled, phaseBEnabled: gates.phaseBEnabled,
      createPhaseACallback: createA, createPhaseBCallback: createB,
      stageTelemetry: resolved.stageTelemetry,
    });
  } catch { return null; }
}
function constructOwner(factory) {
  let svc;
  try { svc = Reflect.apply(factory, undefined, []); } catch { return null; }
  try {
    if (!svc || isProxy(svc) || !exactFrozen(svc, [ACCEPT_METHOD])) return null;
    if (typeof own(svc, ACCEPT_METHOD) !== 'function') return null;
    return svc;
  } catch { return null; }
}
function createMicrosoftOauthSharedCallbackDispatch(dependencies) {
  let pinned;
  try { pinned = pinDeps(dependencies); if (!pinned) throw failure(); }
  catch (err) { if (err && err.code === ERROR_CODE) throw err; throw failure(); }
  let used = false;
  async function accept(input, owner) {
    if (used) throw failure();
    used = true;
    if (!pinned.phaseAEnabled && !pinned.phaseBEnabled) return PUB_UNAVAILABLE;
    const querySnap = snapQuery(input); if (!querySnap) throw failure();
    const ownerSnap = snapOwner(owner); if (!ownerSnap) throw failure();
    const chain = [];
    if (pinned.phaseAEnabled) chain.push(pinned.createPhaseACallback);
    if (pinned.phaseBEnabled) chain.push(pinned.createPhaseBCallback);
    for (let i = 0; i < chain.length; i += 1) {
      const svc = constructOwner(chain[i]);
      if (!svc) throw failure();
      const phaseB = pinned.phaseBEnabled && chain[i] === pinned.createPhaseBCallback;
      safeEmitStage(pinned.stageTelemetry, phaseB ? 'phase_b_runtime_constructed' : 'phase_a_started');
      if (phaseB) safeEmitStage(pinned.stageTelemetry, 'phase_b_started');
      let raw;
      try { raw = Reflect.apply(own(svc, ACCEPT_METHOD), svc, [querySnap, ownerSnap]); }
      catch (err) { if (err && err.code === ERROR_CODE) throw err; throw failure(); }
      if (raw != null && (typeof raw === 'object' || typeof raw === 'function') && isProxy(raw)) {
        throw failure();
      }
      if (!isNativePromise(raw)) throw failure();
      let settled;
      try { settled = await raw; }
      catch (err) { if (err && err.code === ERROR_CODE) throw err; throw failure(); }
      const mapped = mapPublicStatus(settled);
      if (!mapped) throw failure();
      if (mapped.status === S_INVALID && i < chain.length - 1) {
        safeEmitStage(pinned.stageTelemetry, 'phase_a_invalid');
        continue;
      }
      return mapped;
    }
    throw failure();
  }
  return Object.freeze({ accept });
}
module.exports = Object.freeze({
  ERROR_CODE, ERROR_MESSAGE, ACCEPT_METHOD, SUNSET_DEPLOYMENT,
  PHASE_A_CALLBACK_ENABLED_ENV, PHASE_B_CALLBACK_ENABLED_ENV, OWNER_KEYS, DEPENDENCY_KEYS,
  STATUS_INVALID: S_INVALID, STATUS_DECLINED: S_DECLINED, STATUS_RECEIVED: S_RECEIVED,
  STATUS_UNAVAILABLE: S_UNAVAILABLE, STATUS_OUTCOME_UNKNOWN: S_OUTCOME,
  PUBLIC_STATUS_INVALID: PUB_INVALID, PUBLIC_STATUS_DECLINED: PUB_DECLINED,
  PUBLIC_STATUS_RECEIVED: PUB_RECEIVED, PUBLIC_STATUS_UNAVAILABLE: PUB_UNAVAILABLE,
  PUBLIC_STATUS_OUTCOME_UNKNOWN: PUB_OUTCOME,
  EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_IMPORT_INERT,
  EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_RUNTIME_WIRED,
  EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_DEFERRED_ACTIVATION,
  EMAIL_MS_SHARED_OAUTH_CALLBACK_DISPATCH_SAFE_FOR_RUNTIME_ROUTE,
  isProxy, isNativePromise, snapGates, snapQuery, snapOwner, mapPublicStatus,
  createMicrosoftOauthSharedCallbackDispatch,
});
