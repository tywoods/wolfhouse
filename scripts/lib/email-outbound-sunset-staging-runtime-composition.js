'use strict';
/** Sunset-staging Gate 3 outbound runtime composition (default-off). Narrow factory only; import inert. */
const {
  createEmailOutboundSendJournalStore, EMAIL_OUTBOUND_SEND_JOURNAL_RUNTIME_WIRED,
  EMAIL_OUTBOUND_SEND_JOURNAL_LOGGING_FORBIDDEN,
} = require('./email-outbound-send-journal-store');
const {
  createDelegatedGrantAccessSession, EMAIL_DELEGATED_GRANT_ACCESS_SESSION_RUNTIME_WIRED,
  SUNSET_DEPLOYMENT: ACCESS_SUNSET,
} = require('./email-delegated-grant-access-session');
const {
  createMicrosoftGraphReplyDraftTransport, EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_RUNTIME_WIRED,
  EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_DELIVERY_FROM_202, EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_LOGGING_FORBIDDEN,
} = require('./email-microsoft-graph-reply-draft-transport');
const {
  createAuthorityBoundOutboundOperation, EMAIL_AUTHORITY_BOUND_OUTBOUND_RUNTIME_WIRED,
  EMAIL_AUTHORITY_BOUND_OUTBOUND_SAFE_FOR_RUNTIME_ROUTE, EMAIL_AUTHORITY_BOUND_OUTBOUND_PERSISTENCE_READY,
  EMAIL_AUTHORITY_BOUND_OUTBOUND_LOGGING_FORBIDDEN,
} = require('./email-authority-bound-outbound-operation');
const {
  wrapReplyDraftTransportForForcedPostSendUncertainty,
} = require('./email-outbound-forced-post-send-uncertainty-seam');
const {
  createSunsetMicrosoftOAuthClientSecretProvider, SUNSET_DEPLOYMENT: SECRET_SUNSET,
} = require('./sunset-microsoft-oauth-provider');
const {
  createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition,
  parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig,
} = require('./email-grant-envelope-azure-kv-sunset-staging-runtime-composition');
const { validateEmailGrantEnvelopeProvider } = require('./email-grant-envelope-provider-contract');
const { createMicrosoftTokenHttpTransport } = require('./email-microsoft-token-http-transport');
const {
  EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES, EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
} = require('./email-microsoft-delegated-oauth-contract');

const ERROR_CODE = 'EMAIL_OUTBOUND_SUNSET_STAGING_RUNTIME_COMPOSITION_INVALID';
const ERROR_MESSAGE = 'Email outbound sunset-staging runtime composition failed.';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const WORKER_ID = 'sunset-email-outbound-dispatch';
const ENV_COMPOSITION_ENABLED = 'EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCATION_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SRC_RE = /^[\x21-\x7e]+$/;
const DEPENDENCY_KEYS = Object.freeze(['env', 'pgClient', 'withTransactionClient', 'https', 'timers']);
const HTTPS_KEYS = Object.freeze(['request']);
const TIMERS_KEYS = Object.freeze(['setTimeout', 'clearTimeout']);
const REQUEST_KEYS = Object.freeze([
  'operation_id', 'approval_id', 'message_text', 'client_id', 'location_id', 'location_key',
  'endpoint_id', 'conversation_id', 'actor_staff_user_id', 'provider_mailbox_id', 'provider_source_message_id',
]);
const PUBLIC_CODES = Object.freeze([
  'email_send_committed', 'email_send_outcome_unknown', 'email_send_recovery',
  'email_send_reauthorization_required', 'email_send_unavailable',
]);
const SURFACE_KEYS = Object.freeze(['dispatchApprovedOutbound']);
if (SECRET_SUNSET !== SUNSET_DEPLOYMENT || ACCESS_SUNSET !== SUNSET_DEPLOYMENT) throw new Error('outbound_runtime_composition_sunset_deployment_mismatch');
if (EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION !== 'phase_b_v1'
    || EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES.join(' ') !== 'User.Read Mail.ReadWrite Mail.Send') {
  throw new Error('outbound_runtime_composition_phase_b_scope_mismatch');
}
if (EMAIL_OUTBOUND_SEND_JOURNAL_RUNTIME_WIRED !== false || EMAIL_OUTBOUND_SEND_JOURNAL_LOGGING_FORBIDDEN !== true
    || EMAIL_DELEGATED_GRANT_ACCESS_SESSION_RUNTIME_WIRED !== false
    || EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_RUNTIME_WIRED !== false
    || EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_DELIVERY_FROM_202 !== false
    || EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_LOGGING_FORBIDDEN !== true
    || EMAIL_AUTHORITY_BOUND_OUTBOUND_RUNTIME_WIRED !== false
    || EMAIL_AUTHORITY_BOUND_OUTBOUND_SAFE_FOR_RUNTIME_ROUTE !== false
    || EMAIL_AUTHORITY_BOUND_OUTBOUND_PERSISTENCE_READY !== false
    || EMAIL_AUTHORITY_BOUND_OUTBOUND_LOGGING_FORBIDDEN !== true) {
  throw new Error('outbound_runtime_composition_owner_safety_unexpected');
}
function failure() {
  const e = new Error(ERROR_MESSAGE);
  Object.defineProperty(e, 'name', { value: 'EmailOutboundSunsetStagingRuntimeCompositionError' });
  Object.defineProperty(e, 'code', { value: ERROR_CODE, enumerable: true });
  return Object.freeze(e);
}
function ownData(o, k) {
  try { const d = Object.getOwnPropertyDescriptor(o, k); return d && Object.prototype.hasOwnProperty.call(d, 'value') && !d.get && !d.set ? d.value : undefined; }
  catch { return undefined; }
}
function exactPlainData(o, keys) {
  try {
    if (!o || typeof o !== 'object' || Array.isArray(o) || Object.getPrototypeOf(o) !== Object.prototype) return false;
    const actual = Reflect.ownKeys(o);
    if (actual.length !== keys.length || actual.some((k) => typeof k !== 'string' || !keys.includes(k))) return false;
    return keys.every((k) => { const d = Object.getOwnPropertyDescriptor(o, k); return Boolean(d && Object.prototype.hasOwnProperty.call(d, 'value') && d.enumerable && !d.get && !d.set); });
  } catch { return false; }
}
function pinNative(raw, keys) {
  try {
    if (!raw || (typeof raw !== 'object' && typeof raw !== 'function') || Array.isArray(raw)) return null;
    const out = {};
    for (const k of keys) {
      let fn = null;
      try {
        const d = Object.getOwnPropertyDescriptor(raw, k);
        if (d && Object.prototype.hasOwnProperty.call(d, 'value') && !d.get && !d.set && typeof d.value === 'function') fn = d.value;
        else if (typeof raw[k] === 'function') fn = raw[k];
      } catch { return null; }
      if (typeof fn !== 'function') return null;
      const owner = raw; out[k] = function pinned(...args) { return Reflect.apply(fn, owner, args); };
    }
    return Object.freeze(out);
  } catch { return null; }
}
function parseUuid(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  return UUID_RE.test(t) && t === raw.trim().toLowerCase() ? t : null;
}
function isEmailOutboundRuntimeCompositionEnabled(env) {
  try { return !!env && typeof env === 'object' && ownData(env, ENV_COMPOSITION_ENABLED) === 'true' && ownData(env, 'LUNA_DEPLOYMENT') === SUNSET_DEPLOYMENT; }
  catch { return false; }
}
function snapshotEnvReadiness(env) {
  try {
    if (!isEmailOutboundRuntimeCompositionEnabled(env)) return null;
    const appId = ownData(env, 'LUNA_EMAIL_OAUTH_CLIENT_ID');
    if (typeof appId !== 'string' || !UUID_RE.test(appId)) return null;
    const kv = parseEmailGrantEnvelopeAzureKvSunsetStagingRuntimeConfig(env);
    if (!kv.ok || kv.composition_enabled !== true) return null;
    return Object.freeze({ env, applicationClientId: appId.toLowerCase() });
  } catch { return null; }
}
function snapshotRequest(raw) {
  try {
    if (!exactPlainData(raw, REQUEST_KEYS)) return null;
    const operationId = parseUuid(ownData(raw, 'operation_id'));
    const approvalId = parseUuid(ownData(raw, 'approval_id'));
    const clientId = parseUuid(ownData(raw, 'client_id'));
    const locationId = parseUuid(ownData(raw, 'location_id'));
    const endpointId = parseUuid(ownData(raw, 'endpoint_id'));
    const conversationId = parseUuid(ownData(raw, 'conversation_id'));
    const actorStaffUserId = parseUuid(ownData(raw, 'actor_staff_user_id'));
    const providerMailboxId = parseUuid(ownData(raw, 'provider_mailbox_id'));
    const locationKey = ownData(raw, 'location_key');
    const messageText = ownData(raw, 'message_text');
    const sourceMessageId = ownData(raw, 'provider_source_message_id');
    if (!operationId || !approvalId || !clientId || !locationId || !endpointId || !conversationId || !actorStaffUserId || !providerMailboxId) return null;
    if (typeof locationKey !== 'string' || !LOCATION_KEY_RE.test(locationKey) || locationKey.length > 64) return null;
    if (typeof messageText !== 'string' || messageText.length < 1 || messageText.length > 64000) return null;
    if (typeof sourceMessageId !== 'string' || sourceMessageId.length < 1 || sourceMessageId.length > 2048
        || !SRC_RE.test(sourceMessageId) || /[/?#]/.test(sourceMessageId) || sourceMessageId.indexOf('@') !== -1) return null;
    return Object.freeze({
      operationId, approvalId, messageText, clientId, locationId, locationKey, endpointId,
      conversationId, actorStaffUserId, providerMailboxId, sourceMessageId,
    });
  } catch { return null; }
}
function mapPublic(result) {
  try {
    if (!result || typeof result !== 'object') return Object.freeze({ ok: false, code: 'email_send_unavailable' });
    if (result.ok === true && result.value && typeof result.value === 'object') {
      const st = ownData(result.value, 'status');
      if (st === 'committed') return Object.freeze({ ok: true, code: 'email_send_committed' });
      if (st === 'reauthorization_required') return Object.freeze({ ok: false, code: 'email_send_reauthorization_required' });
      if (st === 'unavailable') return Object.freeze({ ok: false, code: 'email_send_unavailable' });
      if (st === 'recovery') return Object.freeze({ ok: false, code: 'email_send_recovery' });
      return Object.freeze({ ok: false, code: 'email_send_outcome_unknown' });
    }
    return Object.freeze({ ok: false, code: 'email_send_unavailable' });
  } catch { return Object.freeze({ ok: false, code: 'email_send_unavailable' }); }
}
/** @returns {Readonly<{ dispatchApprovedOutbound: Function }>} */
function createSunsetStagingEmailOutboundDispatch(deps) {
  try {
    if (!exactPlainData(deps, DEPENDENCY_KEYS)) throw failure();
    const env = ownData(deps, 'env');
    const pgClient = ownData(deps, 'pgClient');
    const withTxnRaw = ownData(deps, 'withTransactionClient');
    const ready = snapshotEnvReadiness(env);
    if (!ready) throw failure(); // flag/env gate before any owner construction
    if (!pgClient || typeof pgClient !== 'object' || typeof pgClient.query !== 'function') throw failure();
    if (typeof pgClient.connect === 'function'
        && (typeof pgClient.totalCount === 'number' || typeof pgClient.idleCount === 'number')) throw failure();
    if (typeof withTxnRaw !== 'function') throw failure();
    const withTransactionClient = async (work) => { if (typeof work !== 'function') throw failure(); return withTxnRaw(work); };
    const httpsPinned = pinNative(ownData(deps, 'https'), HTTPS_KEYS);
    const timersPinned = pinNative(ownData(deps, 'timers'), TIMERS_KEYS);
    if (!httpsPinned || !timersPinned) throw failure();
    const composition = createEmailGrantEnvelopeAzureKvSunsetStagingRuntimeComposition(ready.env);
    if (!composition || composition.ok !== true || composition.composition_enabled !== true || !composition.provider) throw failure();
    const prov = validateEmailGrantEnvelopeProvider(composition.provider);
    if (!prov.ok) throw failure();
    const tokenTransport = createMicrosoftTokenHttpTransport(Object.freeze({ httpsImpl: httpsPinned, timers: timersPinned }));
    const baseReplyDraftTransport = createMicrosoftGraphReplyDraftTransport(Object.freeze({ httpsImpl: httpsPinned.request, timers: timersPinned }));
    const applicationClientId = ready.applicationClientId;
    const envelopeProvider = prov.value;
    const readyEnv = ready.env;
    async function dispatchApprovedOutbound(request) {
      const snap = snapshotRequest(request);
      if (!snap) return Object.freeze({ ok: false, code: 'email_send_unavailable' });
      try {
        const journalAuthority = Object.freeze({
          clientId: snap.clientId, locationId: snap.locationId, locationKey: snap.locationKey,
          endpointId: snap.endpointId, conversationId: snap.conversationId, actorStaffUserId: snap.actorStaffUserId,
        });
        const journalStore = createEmailOutboundSendJournalStore(Object.freeze({ withTransactionClient, authority: journalAuthority }));
        function createAccessSession() {
          return createDelegatedGrantAccessSession(Object.freeze({
            deployment: SUNSET_DEPLOYMENT, applicationClientId, client: pgClient, envelopeProvider,
            secretProvider: createSunsetMicrosoftOAuthClientSecretProvider(Object.freeze({ deployment: SUNSET_DEPLOYMENT, env: readyEnv })),
            transport: tokenTransport, workerId: WORKER_ID,
          }));
        }
        // Staging-only default-off seam: after one real sendDraft acceptance, force
        // outcome_unknown before initial reconcile. Fresh wrap per dispatch so recovery
        // does not inherit a prior skip bit and never authorizes a second send.
        const replyDraftTransport = wrapReplyDraftTransportForForcedPostSendUncertainty(baseReplyDraftTransport, readyEnv);
        const operation = createAuthorityBoundOutboundOperation(Object.freeze({
          journalStore, createAccessSession, replyDraftTransport,
          authority: Object.freeze({
            clientId: snap.clientId, locationId: snap.locationId, locationKey: snap.locationKey,
            endpointId: snap.endpointId, conversationId: snap.conversationId, actorStaffUserId: snap.actorStaffUserId,
            providerMailboxId: snap.providerMailboxId, sourceMessageId: snap.sourceMessageId,
          }),
        }));
        return mapPublic(await operation.runAuthorityBoundOutbound(Object.freeze({
          operationId: snap.operationId, approvalId: snap.approvalId, messageText: snap.messageText,
        })));
      } catch { return Object.freeze({ ok: false, code: 'email_send_unavailable' }); }
    }
    return Object.freeze({ dispatchApprovedOutbound });
  } catch (err) {
    if (err && err.code === ERROR_CODE) throw err;
    throw failure();
  }
}
module.exports = Object.freeze({
  ERROR_CODE, ERROR_MESSAGE, SUNSET_DEPLOYMENT, WORKER_ID, ENV_COMPOSITION_ENABLED,
  DEPENDENCY_KEYS, REQUEST_KEYS, PUBLIC_CODES, SURFACE_KEYS,
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION, EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES,
  isEmailOutboundRuntimeCompositionEnabled, createSunsetStagingEmailOutboundDispatch,
});
