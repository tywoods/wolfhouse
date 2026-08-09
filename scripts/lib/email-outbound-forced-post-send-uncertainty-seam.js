'use strict';
/**
 * Sunset-staging ONLY forced post-provider-acceptance uncertainty seam (default-off).
 *
 * After exactly one real Graph sendDraft acceptance is observed in-process, the
 * first subsequent reconcileDraft is short-circuited to a sanitized
 * outcome_unknown / isDraft=true result so the durable journal stays
 * send_dispatched. Recovery re-entry constructs a fresh surface and reconciles
 * the exact persisted immutable draft only.
 *
 * Never skips createReply/update/send or durable intent commits. Never auto-retries.
 * No second provider send. Production / non-Sunset / non-exact env rejected.
 */
const util = require('util');

const SUNSET_DEPLOYMENT = 'sunset-staging';
const ENV_FORCE_POST_SEND_UNCERTAINTY = 'EMAIL_OUTBOUND_FORCE_POST_SEND_UNCERTAINTY';
const ENV_DEPLOYMENT = 'LUNA_DEPLOYMENT';
const TRANSPORT_KEYS = Object.freeze(['createReply', 'updateApprovedDraft', 'sendDraft', 'reconcileDraft']);
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);

const PINNED_UTIL_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_UTIL_TYPES && typeof PINNED_UTIL_TYPES.isProxy === 'function'
  ? PINNED_UTIL_TYPES.isProxy
  : null;
const PINNED_GOPD = typeof Object.getOwnPropertyDescriptor === 'function'
  ? Object.getOwnPropertyDescriptor
  : null;
const PINNED_GPO = typeof Object.getPrototypeOf === 'function' ? Object.getPrototypeOf : null;
const PINNED_OBJECT_PROTO = Object.prototype;
const PINNED_HAS_OWN = typeof Object.prototype.hasOwnProperty === 'function'
  ? Object.prototype.hasOwnProperty
  : null;
const PINNED_REFLECT_APPLY = typeof Reflect.apply === 'function' ? Reflect.apply : null;
const PINNED_REFLECT_OWN_KEYS = typeof Reflect.ownKeys === 'function' ? Reflect.ownKeys : null;
const PINNED_FREEZE = typeof Object.freeze === 'function' ? Object.freeze : null;
const PINNED_READY = Boolean(
  PINNED_IS_PROXY && PINNED_UTIL_TYPES && PINNED_GOPD && PINNED_GPO && PINNED_HAS_OWN
  && PINNED_REFLECT_APPLY && PINNED_REFLECT_OWN_KEYS && PINNED_FREEZE && PINNED_OBJECT_PROTO,
);

/** Module-init pin: ambient process.env mutation after load cannot re-enable this seam. */
const MODULE_INIT_PROCESS_ENV_FORCE = (() => {
  try {
    if (!process || !process.env || typeof process.env !== 'object') return '';
    const d = Object.getOwnPropertyDescriptor(process.env, ENV_FORCE_POST_SEND_UNCERTAINTY);
    if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set) return '';
    return typeof d.value === 'string' ? d.value : '';
  } catch { return ''; }
})();
const MODULE_INIT_PROCESS_ENV_DEPLOYMENT = (() => {
  try {
    if (!process || !process.env || typeof process.env !== 'object') return '';
    const d = Object.getOwnPropertyDescriptor(process.env, ENV_DEPLOYMENT);
    if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set) return '';
    return typeof d.value === 'string' ? d.value : '';
  } catch { return ''; }
})();

function freeze(v) { return PINNED_FREEZE.call(Object, v); }
function isProxy(v) {
  try {
    if (!PINNED_READY) return true;
    return PINNED_REFLECT_APPLY.call(Reflect, PINNED_IS_PROXY, PINNED_UTIL_TYPES, [v]) === true;
  } catch { return true; }
}
function ownData(o, k) {
  try {
    if (!PINNED_GOPD || !PINNED_HAS_OWN || !o) return undefined;
    const d = PINNED_GOPD.call(Object, o, k);
    return d && PINNED_HAS_OWN.call(d, 'value') && !d.get && !d.set ? d.value : undefined;
  } catch { return undefined; }
}
function exactPlainEnv(env) {
  try {
    if (!PINNED_READY || !env || typeof env !== 'object' || Array.isArray(env) || isProxy(env)) return false;
    // process.env and plain Object snapshots accepted; reject Array/proxy/function.
    return true;
  } catch { return false; }
}

/**
 * Exact enable: LUNA_DEPLOYMENT === 'sunset-staging' AND force flag === 'true' (byte-exact).
 * Rejects production, non-Sunset, TRUE/1/yes, accessors, proxies.
 * When env is process.env, module-init pins must also match (anti ambient mutation).
 */
function isForcedPostSendUncertaintyEnabled(env) {
  try {
    if (!exactPlainEnv(env)) return false;
    const deployment = ownData(env, ENV_DEPLOYMENT);
    const force = ownData(env, ENV_FORCE_POST_SEND_UNCERTAINTY);
    if (deployment !== SUNSET_DEPLOYMENT) return false;
    if (force !== 'true') return false;
    // process.env ambient mutation after module load cannot re-enable.
    if (env === process.env) {
      if (MODULE_INIT_PROCESS_ENV_DEPLOYMENT !== SUNSET_DEPLOYMENT) return false;
      if (MODULE_INIT_PROCESS_ENV_FORCE !== 'true') return false;
    }
    return true;
  } catch { return false; }
}

function resolveCallable(surface, key) {
  try {
    if (!surface || (typeof surface !== 'object' && typeof surface !== 'function') || isProxy(surface)) return null;
    const d = PINNED_GOPD.call(Object, surface, key);
    if (!d || !PINNED_HAS_OWN.call(d, 'value') || typeof d.value !== 'function' || d.get || d.set || isProxy(d.value)) {
      return null;
    }
    return d.value;
  } catch { return null; }
}

function ownDataField(o, k) {
  try {
    if (!o || typeof o !== 'object' || isProxy(o)) return undefined;
    return ownData(o, k);
  } catch { return undefined; }
}

/**
 * Wrap a frozen reply-draft transport. When enabled, after one accepted sendDraft,
 * the next reconcileDraft returns sanitized outcome_unknown without provider I/O.
 * Fresh wrappers (recovery) start with no pending skip.
 *
 * @param {object} transport
 * @param {object} env
 * @returns {object} original transport or frozen wrap
 */
function wrapReplyDraftTransportForForcedPostSendUncertainty(transport, env) {
  if (!PINNED_READY) return transport;
  const enabled = isForcedPostSendUncertaintyEnabled(env);
  if (!enabled) return transport;
  try {
    if (!transport || (typeof transport !== 'object' && typeof transport !== 'function') || isProxy(transport)) {
      return transport;
    }
    const methods = {};
    for (const k of TRANSPORT_KEYS) {
      const fn = resolveCallable(transport, k);
      if (!fn) return transport;
      methods[k] = fn;
    }
    // Pin enabled snapshot — ambient env mutation after wrap cannot disable mid-flight.
    const forceEnabledPinned = true;
    let pendingSkipReconcile = false;
    const receiver = transport;
    const wrapped = {
      createReply(...args) {
        return PINNED_REFLECT_APPLY.call(Reflect, methods.createReply, receiver, args);
      },
      updateApprovedDraft(...args) {
        return PINNED_REFLECT_APPLY.call(Reflect, methods.updateApprovedDraft, receiver, args);
      },
      async sendDraft(...args) {
        const result = await PINNED_REFLECT_APPLY.call(Reflect, methods.sendDraft, receiver, args);
        if (forceEnabledPinned && result && typeof result === 'object' && !isProxy(result)
            && ownDataField(result, 'delivery_claimed') === false) {
          // Exactly one real send acceptance observed; force uncertainty before reconcile commit.
          pendingSkipReconcile = true;
        }
        return result;
      },
      async reconcileDraft(...args) {
        if (forceEnabledPinned && pendingSkipReconcile) {
          pendingSkipReconcile = false;
          const req = args && args[0];
          const draftId = ownDataField(req, 'immutable_draft_id');
          // Sanitized transport-shaped result: isDraft remains true → journal stays send_dispatched.
          return freeze({
            outcome: 'outcome_unknown',
            isDraft: true,
            immutable_draft_id: typeof draftId === 'string' ? draftId : undefined,
            authorize_automatic_resend: false,
            authorize_automatic_create_reply: false,
            forced_post_send_uncertainty: true,
          });
        }
        return PINNED_REFLECT_APPLY.call(Reflect, methods.reconcileDraft, receiver, args);
      },
    };
    // Ensure exact key set for resolveMethodBag consumers.
    const keys = PINNED_REFLECT_OWN_KEYS.call(Reflect, wrapped);
    if (!keys || keys.length !== TRANSPORT_KEYS.length
        || keys.some((k) => typeof k !== 'string' || DANGEROUS.has(k) || !TRANSPORT_KEYS.includes(k))) {
      return transport;
    }
    return freeze(wrapped);
  } catch {
    return transport;
  }
}

module.exports = freeze({
  SUNSET_DEPLOYMENT,
  ENV_FORCE_POST_SEND_UNCERTAINTY,
  ENV_DEPLOYMENT,
  TRANSPORT_KEYS,
  MODULE_INIT_PROCESS_ENV_FORCE,
  MODULE_INIT_PROCESS_ENV_DEPLOYMENT,
  isForcedPostSendUncertaintyEnabled,
  wrapReplyDraftTransportForForcedPostSendUncertainty,
});
