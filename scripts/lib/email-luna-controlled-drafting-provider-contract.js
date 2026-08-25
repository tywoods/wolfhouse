'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 1.
 *
 * Canonical package-first Microsoft Graph draft-only provider boundary.
 * Unwired: no worker composition, no OAuth, no live Graph, no send.
 *
 * Reuses Gate 3 Graph path grammar (createReply / PATCH / GET draft) from
 * email-microsoft-graph-reply-draft-transport. Does not re-export that
 * transport, its sendDraft/sendMail methods, tokens, or generic HTTP.
 */

const util = require('node:util');
const nodeCrypto = require('node:crypto');
const {
  HOST,
  PREFER_IMMUTABLE_ID,
  buildCreateReplyPath,
  buildMessagePath,
} = require('./email-microsoft-graph-reply-draft-transport');
const {
  EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES,
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
} = require('./email-microsoft-delegated-oauth-contract');

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const objectFreeze = Object.freeze;
const objectCreate = Object.create;
const objectHasOwn = Object.hasOwn;
const objectIsFrozen = Object.isFrozen;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const regexpTest = uncurryThis(RegExp.prototype.test);
const arrayIncludes = uncurryThis(Array.prototype.includes);

const PINNED_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_TYPES && typeof PINNED_TYPES.isProxy === 'function'
  ? PINNED_TYPES.isProxy.bind(PINNED_TYPES)
  : null;
const cryptoCreateHash = typeof nodeCrypto.createHash === 'function'
  ? nodeCrypto.createHash.bind(nodeCrypto)
  : null;

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting provider failed.';
const EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED = false;
const EMAIL_LUNA_CONTROLLED_DRAFTING_ACTIVATION = false;
const EMAIL_LUNA_CONTROLLED_DRAFTING_LOGGING_FORBIDDEN = true;
const EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER = 'microsoft_graph';
const EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY = 'sunset-somo';
const EMAIL_LUNA_CONTROLLED_DRAFTING_SCOPE_VERSION = 'controlled_drafting_v1';

const EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATIONS = objectFreeze([
  'create_reply_draft',
  'reconcile_draft',
]);
const EMAIL_LUNA_CONTROLLED_DRAFTING_GRAPH_CALL_OPERATIONS = objectFreeze([
  'create_reply_draft',
  'patch_reply_draft',
  'reconcile_draft',
]);
const EMAIL_LUNA_CONTROLLED_DRAFTING_TRANSPORT_KEYS = objectFreeze([
  'createReplyDraft',
  'reconcileDraft',
]);
const EMAIL_LUNA_CONTROLLED_DRAFTING_AUTHORITY_KEYS = objectFreeze([
  'client_id',
  'location_id',
  'location_key',
  'endpoint_id',
  'provider',
  'mailbox_id',
]);
const EMAIL_LUNA_CONTROLLED_DRAFTING_CREATE_REQUEST_KEYS = objectFreeze([
  'client_id',
  'location_id',
  'location_key',
  'endpoint_id',
  'provider',
  'mailbox_id',
  'inbound_provider_message_id',
  'inbound_provider_thread_id',
  'recipient_address',
  'subject',
  'body_text',
  'subject_digest',
  'body_digest',
  'issuance_id',
  'operation_id',
]);
const EMAIL_LUNA_CONTROLLED_DRAFTING_CREATE_RESPONSE_KEYS = objectFreeze([
  'outcome',
  'client_id',
  'location_id',
  'location_key',
  'endpoint_id',
  'provider',
  'mailbox_id',
  'inbound_provider_message_id',
  'inbound_provider_thread_id',
  'recipient_address',
  'subject_digest',
  'body_digest',
  'issuance_id',
  'operation_id',
  'provider_draft_id',
]);
const EMAIL_LUNA_CONTROLLED_DRAFTING_RECONCILE_REQUEST_KEYS = objectFreeze([
  'client_id',
  'location_id',
  'location_key',
  'endpoint_id',
  'provider',
  'mailbox_id',
  'inbound_provider_message_id',
  'inbound_provider_thread_id',
  'recipient_address',
  'subject_digest',
  'body_digest',
  'issuance_id',
  'operation_id',
  'provider_draft_id',
]);
const EMAIL_LUNA_CONTROLLED_DRAFTING_RECONCILE_RESPONSE_KEYS = objectFreeze([
  'outcome',
  'client_id',
  'location_id',
  'location_key',
  'endpoint_id',
  'provider',
  'mailbox_id',
  'inbound_provider_message_id',
  'inbound_provider_thread_id',
  'recipient_address',
  'subject_digest',
  'body_digest',
  'issuance_id',
  'operation_id',
  'provider_draft_id',
  'is_draft',
]);
const CREATE_INNER_KEYS = objectFreeze([
  'mailbox_id',
  'inbound_provider_message_id',
  'inbound_provider_thread_id',
  'recipient_address',
  'subject',
  'body_text',
  'subject_digest',
  'body_digest',
  'issuance_id',
  'operation_id',
]);
const RECONCILE_INNER_KEYS = objectFreeze([
  'mailbox_id',
  'inbound_provider_message_id',
  'inbound_provider_thread_id',
  'recipient_address',
  'subject_digest',
  'body_digest',
  'issuance_id',
  'operation_id',
  'provider_draft_id',
]);
const TRANSPORT_RESULT_KEYS = objectFreeze(['provider_draft_id', 'is_draft']);
const RECONCILE_TRANSPORT_RESULT_KEYS = objectFreeze([
  'provider_draft_id',
  'is_draft',
  'found',
  'subject_digest',
  'body_digest',
  'recipient_address',
  'inbound_provider_thread_id',
  'mailbox_id',
]);
const RECONCILE_OUTCOMES = objectFreeze([
  'draft_present',
  'draft_modified',
  'draft_not_found',
  'draft_mismatch',
]);
const FACTORY_KEYS = objectFreeze(['authority', 'transport']);
const CAPABILITY_KEYS = objectFreeze([
  'create_reply_draft',
  'reconcile_draft',
  'send',
  'send_draft',
  'send_mail',
  'schedule_send',
  'forward_send',
  'reply_send',
  'arbitrary_message_mutation',
  'generic_http',
  'raw_sdk',
  'access_token_export',
]);
const FORBIDDEN_TRANSPORT_KEYS = objectFreeze([
  'send',
  'sendDraft',
  'sendMail',
  'scheduleSend',
  'forward',
  'createForward',
  'reply',
  'replyAll',
  'createReplyAll',
  'request',
  'https',
  'http',
  'client',
  'graphClient',
  'accessToken',
  'access_token',
  'path',
  'url',
  'method',
]);
const FORBIDDEN_FIELD_NAMES = objectFreeze([
  'access_token',
  'refresh_token',
  'id_token',
  'accessToken',
  'refreshToken',
  'Authorization',
  'authorization',
  'token',
  'client_secret',
  'password',
  'api_key',
  'raw_secret',
]);

const EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST = objectFreeze({
  id: 'email-luna-controlled-drafting-provider.v1',
  slice: 'FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 1',
  provider: EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER,
  operations: EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATIONS,
  capabilities: objectFreeze({
    create_reply_draft: true,
    reconcile_draft: true,
    send: false,
    send_draft: false,
    send_mail: false,
    schedule_send: false,
    forward_send: false,
    reply_send: false,
    arbitrary_message_mutation: false,
    generic_http: false,
    raw_sdk: false,
    access_token_export: false,
  }),
  runtime_wired: false,
  activation: false,
  consent: false,
  auto_send_flag_is_not_authority: true,
});

const EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE = objectFreeze({
  id: EMAIL_LUNA_CONTROLLED_DRAFTING_SCOPE_VERSION,
  mutates_phase_a: false,
  mutates_phase_b: false,
  consent_activation: false,
  oidc: objectFreeze(['openid', 'profile', 'offline_access']),
  optional_oidc: objectFreeze(['email']),
  graph_delegated: objectFreeze(['User.Read', 'Mail.ReadWrite']),
  excluded_graph: objectFreeze([
    'Mail.Send',
    'Mail.Send.Shared',
    'Mail.ReadWrite.Shared',
    'Mail.Read.Shared',
    'Mail.Read',
    'Mail.ReadBasic',
    '/.default',
  ]),
  live_phase_b_untouched: objectFreeze({
    scope_version: EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
    graph_delegated: objectFreeze(EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES.slice()),
  }),
});

const EMAIL_MS_CONTROLLED_DRAFTING_PROVIDER_FACTS = objectFreeze({
  mail_readwrite_creates_reads_updates_deletes_user_mail: true,
  mail_readwrite_does_not_include_send: true,
  mail_send_required_to_send: true,
  create_reply_requires_mail_readwrite: true,
  this_profile_omits_mail_send: true,
  source: 'Microsoft Graph permissions reference: Mail.ReadWrite allows create, read, update, and delete of user mail and does not include permission to send mail. Mail.Send is required to send.',
});

const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST_CANON = /^[0-9a-f]{64}$/;
const LOCATION_KEY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RECIPIENT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GRAPH_ID_RE = /^[\x21-\x7e]+$/;
const STRING_LIMIT = 2048;
const SUBJECT_LIMIT = 998;
const BODY_LIMIT = 64_000;
const SCOPE_MAX = 512;
const CONTROLLED_DRAFTING_OIDC = EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE.oidc;
const CONTROLLED_DRAFTING_OPTIONAL_OIDC = EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE.optional_oidc;
const CONTROLLED_DRAFTING_GRAPH = EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE.graph_delegated;
const CONTROLLED_DRAFTING_TOKEN_ORDER = objectFreeze([
  'openid',
  'profile',
  'offline_access',
  'email',
  'User.Read',
  'Mail.ReadWrite',
]);
const CONTROLLED_DRAFTING_TOKEN_ALLOWED = new Set(CONTROLLED_DRAFTING_TOKEN_ORDER);
const FAKE_OPTION_KEYS = objectFreeze([
  'createResult',
  'reconcileResult',
  'createError',
  'reconcileError',
  'classify',
]);
const PROVIDER_SURFACE_KEYS = objectFreeze(['attest', 'createReplyDraft', 'reconcileDraft']);

if (EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION !== 'phase_b_v1'
    || EMAIL_MS_DELEGATED_PHASE_B_V1_GRAPH_DELEGATED_SCOPES.join(' ') !== 'User.Read Mail.ReadWrite Mail.Send') {
  throw new Error('controlled_drafting_phase_b_scope_owner_unexpected');
}
if (arrayIncludes(CONTROLLED_DRAFTING_GRAPH, 'Mail.Send')
    || CONTROLLED_DRAFTING_GRAPH.join(' ') !== 'User.Read Mail.ReadWrite') {
  throw new Error('controlled_drafting_scope_must_omit_mail_send');
}
{
  const capabilities = EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST.capabilities;
  const capKeys = reflectOwnKeys(capabilities);
  if (capKeys.length !== CAPABILITY_KEYS.length) {
    throw new Error('controlled_drafting_capability_manifest_not_closed');
  }
  for (let i = 0; i < CAPABILITY_KEYS.length; i += 1) {
    const key = CAPABILITY_KEYS[i];
    if (!objectHasOwn(capabilities, key) || typeof capabilities[key] !== 'boolean') {
      throw new Error('controlled_drafting_capability_manifest_not_closed');
    }
  }
  if (capabilities.send === true || capabilities.send_draft === true || capabilities.send_mail === true
      || capabilities.schedule_send === true || capabilities.forward_send === true
      || capabilities.reply_send === true || capabilities.generic_http === true
      || capabilities.raw_sdk === true || capabilities.access_token_export === true
      || capabilities.arbitrary_message_mutation === true
      || capabilities.create_reply_draft !== true || capabilities.reconcile_draft !== true) {
    throw new Error('controlled_drafting_capability_manifest_send_not_absent');
  }
}

function invalid() {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  objectFreeze(error);
  return error;
}

function isProxySurface(value) {
  try {
    if (!PINNED_IS_PROXY) return true;
    return PINNED_IS_PROXY(value) === true;
  } catch (_) {
    return true;
  }
}

function ownData(object, key) {
  try {
    const descriptor = objectGetOwnPropertyDescriptor(object, key);
    if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
      return undefined;
    }
    return descriptor.value;
  } catch (_) {
    return undefined;
  }
}

function exactOwnData(value, keys) {
  if (value === null || typeof value !== 'object' || arrayIsArray(value) || isProxySurface(value)) {
    return null;
  }
  try {
    const proto = objectGetPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = reflectOwnKeys(value);
    if (actual.length !== keys.length) return null;
    const copy = objectCreate(null);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (!arrayIncludes(actual, key) || typeof key !== 'string') return null;
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
        return null;
      }
      copy[key] = descriptor.value;
    }
    return copy;
  } catch (_) {
    return null;
  }
}

function subsetOwnData(value, allowed) {
  if (value === null || typeof value !== 'object' || arrayIsArray(value) || isProxySurface(value)) {
    return null;
  }
  try {
    const proto = objectGetPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const actual = reflectOwnKeys(value);
    const copy = objectCreate(null);
    for (let i = 0; i < actual.length; i += 1) {
      const key = actual[i];
      if (typeof key !== 'string' || !arrayIncludes(allowed, key)) return null;
      const descriptor = objectGetOwnPropertyDescriptor(value, key);
      if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
        return null;
      }
      copy[key] = descriptor.value;
    }
    return copy;
  } catch (_) {
    return null;
  }
}

function freezeExact(keys, values) {
  const out = {};
  for (let i = 0; i < keys.length; i += 1) {
    out[keys[i]] = values[keys[i]];
  }
  return objectFreeze(out);
}

function isCanonUuid(value) {
  return typeof value === 'string' && regexpTest(UUID_CANON, value);
}

function isGraphId(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= STRING_LIMIT
    && regexpTest(GRAPH_ID_RE, value)
    && !/[/?#]/.test(value);
}

function isRecipient(value) {
  return typeof value === 'string'
    && value === value.trim()
    && value === value.toLowerCase()
    && value.length >= 3
    && value.length <= 320
    && regexpTest(RECIPIENT_RE, value);
}

function digestUtf8(value) {
  if (!cryptoCreateHash || typeof value !== 'string') return null;
  try {
    const hasher = cryptoCreateHash('sha256');
    hasher.update(value, 'utf8');
    const hex = hasher.digest('hex');
    return typeof hex === 'string' && regexpTest(DIGEST_CANON, hex) ? hex : null;
  } catch (_) {
    return null;
  }
}

function rejectForbiddenFields(record) {
  const keys = reflectOwnKeys(record);
  for (let i = 0; i < keys.length; i += 1) {
    if (arrayIncludes(FORBIDDEN_FIELD_NAMES, keys[i])) return false;
  }
  return true;
}

function readAuthority(raw) {
  const parsed = exactOwnData(raw, EMAIL_LUNA_CONTROLLED_DRAFTING_AUTHORITY_KEYS);
  if (!parsed || !rejectForbiddenFields(parsed)) return null;
  if (!isCanonUuid(parsed.client_id) || !isCanonUuid(parsed.location_id) || !isCanonUuid(parsed.endpoint_id)) {
    return null;
  }
  if (parsed.location_key !== EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY
      || !regexpTest(LOCATION_KEY_RE, parsed.location_key)) {
    return null;
  }
  if (parsed.provider !== EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER) return null;
  if (!isCanonUuid(parsed.mailbox_id)) return null;
  return freezeExact(EMAIL_LUNA_CONTROLLED_DRAFTING_AUTHORITY_KEYS, parsed);
}

function matchAuthority(authority, request) {
  for (let i = 0; i < EMAIL_LUNA_CONTROLLED_DRAFTING_AUTHORITY_KEYS.length; i += 1) {
    const key = EMAIL_LUNA_CONTROLLED_DRAFTING_AUTHORITY_KEYS[i];
    if (request[key] !== authority[key]) return false;
  }
  return true;
}

function readCreateRequest(raw) {
  const parsed = exactOwnData(raw, EMAIL_LUNA_CONTROLLED_DRAFTING_CREATE_REQUEST_KEYS);
  if (!parsed || !rejectForbiddenFields(parsed)) return null;
  if (!isCanonUuid(parsed.client_id) || !isCanonUuid(parsed.location_id) || !isCanonUuid(parsed.endpoint_id)) {
    return null;
  }
  if (parsed.location_key !== EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY) return null;
  if (parsed.provider !== EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER || !isCanonUuid(parsed.mailbox_id)) return null;
  if (!isGraphId(parsed.inbound_provider_message_id) || !isGraphId(parsed.inbound_provider_thread_id)) return null;
  if (!isRecipient(parsed.recipient_address)) return null;
  if (typeof parsed.subject !== 'string' || parsed.subject.length < 1 || parsed.subject.length > SUBJECT_LIMIT
      || /[\x00-\x1f\x7f]/.test(parsed.subject) || parsed.subject !== parsed.subject.trim()) {
    return null;
  }
  if (typeof parsed.body_text !== 'string' || parsed.body_text.length < 1 || parsed.body_text.length > BODY_LIMIT) {
    return null;
  }
  const subjectDigest = digestUtf8(parsed.subject);
  const bodyDigest = digestUtf8(parsed.body_text);
  if (subjectDigest !== parsed.subject_digest || bodyDigest !== parsed.body_digest) return null;
  if (!isCanonUuid(parsed.issuance_id) || !isCanonUuid(parsed.operation_id)) return null;
  if (buildCreateReplyPath(parsed.mailbox_id, parsed.inbound_provider_message_id) === null) return null;
  return parsed;
}

function readReconcileRequest(raw) {
  const parsed = exactOwnData(raw, EMAIL_LUNA_CONTROLLED_DRAFTING_RECONCILE_REQUEST_KEYS);
  if (!parsed || !rejectForbiddenFields(parsed)) return null;
  if (!isCanonUuid(parsed.client_id) || !isCanonUuid(parsed.location_id) || !isCanonUuid(parsed.endpoint_id)) {
    return null;
  }
  if (parsed.location_key !== EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY) return null;
  if (parsed.provider !== EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER || !isCanonUuid(parsed.mailbox_id)) return null;
  if (!isGraphId(parsed.inbound_provider_message_id) || !isGraphId(parsed.inbound_provider_thread_id)) return null;
  if (!isRecipient(parsed.recipient_address)) return null;
  if (!regexpTest(DIGEST_CANON, parsed.subject_digest) || !regexpTest(DIGEST_CANON, parsed.body_digest)) return null;
  if (!isCanonUuid(parsed.issuance_id) || !isCanonUuid(parsed.operation_id)) return null;
  if (!isGraphId(parsed.provider_draft_id)) return null;
  if (buildMessagePath(parsed.mailbox_id, parsed.provider_draft_id, 'get') === null) return null;
  return parsed;
}

function copyKeys(keys, source) {
  const out = objectCreate(null);
  for (let i = 0; i < keys.length; i += 1) out[keys[i]] = source[keys[i]];
  return objectFreeze(out);
}

function readTransportResult(raw) {
  const parsed = exactOwnData(raw, TRANSPORT_RESULT_KEYS);
  if (!parsed) return null;
  if (!isGraphId(parsed.provider_draft_id) || parsed.is_draft !== true) return null;
  return parsed;
}

function readReconcileTransportResult(raw) {
  const parsed = subsetOwnData(raw, RECONCILE_TRANSPORT_RESULT_KEYS);
  if (!parsed) return null;
  if (parsed.found === false) {
    const keys = reflectOwnKeys(parsed);
    if (keys.length !== 1) return null;
    return objectFreeze({ kind: 'not_found' });
  }
  if (!isGraphId(parsed.provider_draft_id)) return null;
  if (parsed.is_draft === false) {
    return objectFreeze({
      kind: 'mismatch',
      provider_draft_id: parsed.provider_draft_id,
      is_draft: false,
    });
  }
  if (parsed.is_draft !== true) return null;
  return objectFreeze({
    kind: 'present',
    provider_draft_id: parsed.provider_draft_id,
    is_draft: true,
    subject_digest: objectHasOwn(parsed, 'subject_digest') ? parsed.subject_digest : null,
    body_digest: objectHasOwn(parsed, 'body_digest') ? parsed.body_digest : null,
    recipient_address: objectHasOwn(parsed, 'recipient_address') ? parsed.recipient_address : null,
    inbound_provider_thread_id: objectHasOwn(parsed, 'inbound_provider_thread_id')
      ? parsed.inbound_provider_thread_id : null,
    mailbox_id: objectHasOwn(parsed, 'mailbox_id') ? parsed.mailbox_id : null,
  });
}

function pickEmailLunaControlledDraftingTransportMethods(transport) {
  const parsed = exactOwnData(transport, EMAIL_LUNA_CONTROLLED_DRAFTING_TRANSPORT_KEYS);
  if (!parsed) throw invalid();
  const extraProbe = subsetOwnData(transport, [
    ...EMAIL_LUNA_CONTROLLED_DRAFTING_TRANSPORT_KEYS,
    ...FORBIDDEN_TRANSPORT_KEYS,
  ]);
  if (!extraProbe) throw invalid();
  for (let i = 0; i < FORBIDDEN_TRANSPORT_KEYS.length; i += 1) {
    if (objectHasOwn(extraProbe, FORBIDDEN_TRANSPORT_KEYS[i])) throw invalid();
  }
  const createReplyDraft = parsed.createReplyDraft;
  const reconcileDraft = parsed.reconcileDraft;
  if (typeof createReplyDraft !== 'function' || typeof reconcileDraft !== 'function') throw invalid();
  if (isProxySurface(createReplyDraft) || isProxySurface(reconcileDraft)) throw invalid();
  return objectFreeze({ createReplyDraft, reconcileDraft });
}

function attestEmailLunaControlledDraftingCapabilities() {
  return EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST;
}

function snapshotStringArray(value) {
  if (!arrayIsArray(value) || isProxySurface(value)) return null;
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    const descriptor = objectGetOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !objectHasOwn(descriptor, 'value') || descriptor.get || descriptor.set) return null;
    if (typeof descriptor.value !== 'string' || descriptor.value.length < 1) return null;
    out.push(descriptor.value);
  }
  return out;
}

function validateControlledDraftingScopeProfile(raw) {
  const parsed = exactOwnData(raw, objectFreeze(['oidc', 'graph_delegated', 'include_email_scope']));
  if (!parsed) throw invalid();
  if (parsed.include_email_scope !== true && parsed.include_email_scope !== false) throw invalid();
  const oidc = snapshotStringArray(parsed.oidc);
  const graph = snapshotStringArray(parsed.graph_delegated);
  if (!oidc || !graph) throw invalid();
  if (oidc.length !== CONTROLLED_DRAFTING_OIDC.length) throw invalid();
  for (let i = 0; i < CONTROLLED_DRAFTING_OIDC.length; i += 1) {
    if (!arrayIncludes(oidc, CONTROLLED_DRAFTING_OIDC[i])) throw invalid();
  }
  if (graph.length !== CONTROLLED_DRAFTING_GRAPH.length) throw invalid();
  for (let i = 0; i < CONTROLLED_DRAFTING_GRAPH.length; i += 1) {
    if (graph[i] !== CONTROLLED_DRAFTING_GRAPH[i]) throw invalid();
  }
  if (arrayIncludes(graph, 'Mail.Send') || arrayIncludes(oidc, 'Mail.Send')) throw invalid();
  return objectFreeze({
    ok: true,
    scope_version: EMAIL_LUNA_CONTROLLED_DRAFTING_SCOPE_VERSION,
    oidc: CONTROLLED_DRAFTING_OIDC,
    graph_delegated: CONTROLLED_DRAFTING_GRAPH,
    include_email_scope: parsed.include_email_scope === true,
    mail_send: false,
  });
}

function validateControlledDraftingTokenResponseScope(scope) {
  if (typeof scope !== 'string' || scope.length < 1 || scope.length > SCOPE_MAX) throw invalid();
  const parts = scope.split(' ');
  const seen = new Set();
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (!part || !CONTROLLED_DRAFTING_TOKEN_ALLOWED.has(part) || seen.has(part)) throw invalid();
    if (part === 'Mail.Send' || part.includes('.Shared') || part.endsWith('.All') || part.includes('/.default')) {
      throw invalid();
    }
    seen.add(part);
  }
  for (let i = 0; i < CONTROLLED_DRAFTING_GRAPH.length; i += 1) {
    if (!seen.has(CONTROLLED_DRAFTING_GRAPH[i])) throw invalid();
  }
  return CONTROLLED_DRAFTING_TOKEN_ORDER.filter((item) => seen.has(item)).join(' ');
}

function resolveControlledDraftingGraphCall(raw) {
  const parsed = subsetOwnData(raw, objectFreeze([
    'operation',
    'mailbox_id',
    'inbound_provider_message_id',
    'provider_draft_id',
  ]));
  if (!parsed) throw invalid();
  const operation = parsed.operation;
  const mailboxId = parsed.mailbox_id;
  if (typeof operation !== 'string' || !arrayIncludes(EMAIL_LUNA_CONTROLLED_DRAFTING_GRAPH_CALL_OPERATIONS, operation)) {
    throw invalid();
  }
  if (!isCanonUuid(mailboxId)) throw invalid();
  if (operation === 'create_reply_draft') {
    const keys = exactOwnData(raw, objectFreeze(['operation', 'mailbox_id', 'inbound_provider_message_id']));
    if (!keys) throw invalid();
    const path = buildCreateReplyPath(mailboxId, keys.inbound_provider_message_id);
    if (!path) throw invalid();
    return objectFreeze({
      operation,
      method: 'POST',
      host: HOST,
      path,
      prefer: PREFER_IMMUTABLE_ID,
    });
  }
  if (operation === 'patch_reply_draft' || operation === 'reconcile_draft') {
    const keys = exactOwnData(raw, objectFreeze(['operation', 'mailbox_id', 'provider_draft_id']));
    if (!keys) throw invalid();
    const suffix = operation === 'patch_reply_draft' ? 'patch' : 'get';
    const path = buildMessagePath(mailboxId, keys.provider_draft_id, suffix);
    if (!path) throw invalid();
    return objectFreeze({
      operation,
      method: operation === 'patch_reply_draft' ? 'PATCH' : 'GET',
      host: HOST,
      path,
      prefer: PREFER_IMMUTABLE_ID,
    });
  }
  throw invalid();
}

function sameStored(stored, incoming, keys) {
  for (let i = 0; i < keys.length; i += 1) {
    if (stored[keys[i]] !== incoming[keys[i]]) return false;
  }
  return true;
}

function createEmailLunaControlledDraftingFakeTransport(options = {}) {
  const parsed = subsetOwnData(options === undefined ? {} : options, FAKE_OPTION_KEYS);
  if (!parsed) throw invalid();
  const drafts = new Map();
  const calls = [];
  let seq = 0;

  function record(operation, command) {
    calls.push(objectFreeze({
      operation,
      mailbox_id: command.mailbox_id,
      inbound_provider_message_id: command.inbound_provider_message_id,
      inbound_provider_thread_id: command.inbound_provider_thread_id,
      recipient_address: command.recipient_address,
      issuance_id: command.issuance_id,
      operation_id: command.operation_id,
    }));
  }

  function createReplyDraft(input) {
    if (objectHasOwn(parsed, 'createError')) return Promise.reject(parsed.createError);
    const command = exactOwnData(input, CREATE_INNER_KEYS);
    if (!command) return Promise.reject(invalid());
    record('create_reply_draft', command);
    if (objectHasOwn(parsed, 'createResult')) return Promise.resolve(parsed.createResult);
    seq += 1;
    const providerDraftId = `AAMkAGI2-CTRL-DRAFT-${seq}`;
    drafts.set(providerDraftId, objectFreeze({
      mailbox_id: command.mailbox_id,
      inbound_provider_message_id: command.inbound_provider_message_id,
      inbound_provider_thread_id: command.inbound_provider_thread_id,
      recipient_address: command.recipient_address,
      subject_digest: command.subject_digest,
      body_digest: command.body_digest,
      issuance_id: command.issuance_id,
      operation_id: command.operation_id,
      provider_draft_id: providerDraftId,
      is_draft: true,
    }));
    return Promise.resolve(objectFreeze({
      provider_draft_id: providerDraftId,
      is_draft: true,
    }));
  }

  function reconcileDraft(input) {
    if (objectHasOwn(parsed, 'reconcileError')) return Promise.reject(parsed.reconcileError);
    const command = exactOwnData(input, RECONCILE_INNER_KEYS);
    if (!command) return Promise.reject(invalid());
    record('reconcile_draft', command);
    if (objectHasOwn(parsed, 'reconcileResult')) return Promise.resolve(parsed.reconcileResult);
    const classify = parsed.classify === true;
    const stored = drafts.get(command.provider_draft_id);
    if (!stored) {
      return classify
        ? Promise.resolve(objectFreeze({ found: false }))
        : Promise.reject(invalid());
    }
    if (stored.is_draft !== true) {
      return classify
        ? Promise.resolve(objectFreeze({
          provider_draft_id: stored.provider_draft_id,
          is_draft: false,
        }))
        : Promise.reject(invalid());
    }
    if (!sameStored(stored, command, RECONCILE_INNER_KEYS)) {
      if (!classify) return Promise.reject(invalid());
      return Promise.resolve(objectFreeze({
        provider_draft_id: stored.provider_draft_id,
        is_draft: true,
        subject_digest: stored.subject_digest,
        body_digest: stored.body_digest,
        recipient_address: stored.recipient_address,
        inbound_provider_thread_id: stored.inbound_provider_thread_id,
        mailbox_id: stored.mailbox_id,
      }));
    }
    return Promise.resolve(objectFreeze({
      provider_draft_id: stored.provider_draft_id,
      is_draft: true,
    }));
  }

  function getCalls() {
    return objectFreeze(calls.slice());
  }

  function mutateDraft(providerDraftId, patch) {
    if (!isGraphId(providerDraftId) || !patch || typeof patch !== 'object') throw invalid();
    const stored = drafts.get(providerDraftId);
    if (!stored) throw invalid();
    const next = {
      mailbox_id: stored.mailbox_id,
      inbound_provider_message_id: stored.inbound_provider_message_id,
      inbound_provider_thread_id: stored.inbound_provider_thread_id,
      recipient_address: stored.recipient_address,
      subject_digest: stored.subject_digest,
      body_digest: stored.body_digest,
      issuance_id: stored.issuance_id,
      operation_id: stored.operation_id,
      provider_draft_id: stored.provider_draft_id,
      is_draft: stored.is_draft,
    };
    const allowed = objectFreeze([
      'subject_digest', 'body_digest', 'recipient_address', 'inbound_provider_thread_id',
      'mailbox_id', 'is_draft',
    ]);
    const own = reflectOwnKeys(patch);
    for (let i = 0; i < own.length; i += 1) {
      const key = own[i];
      if (typeof key !== 'string' || !arrayIncludes(allowed, key)) throw invalid();
      next[key] = patch[key];
    }
    drafts.set(providerDraftId, objectFreeze(next));
  }

  function deleteDraft(providerDraftId) {
    if (!isGraphId(providerDraftId)) throw invalid();
    drafts.delete(providerDraftId);
  }

  return objectFreeze({ createReplyDraft, reconcileDraft, getCalls, mutateDraft, deleteDraft });
}

function createEmailLunaControlledDraftingProvider(dependencies) {
  const parsed = exactOwnData(dependencies, FACTORY_KEYS);
  if (!parsed) throw invalid();
  const authority = readAuthority(parsed.authority);
  if (!authority) throw invalid();
  const transport = pickEmailLunaControlledDraftingTransportMethods(parsed.transport);

  function attest(...args) {
    if (args.length !== 0) throw invalid();
    return objectFreeze({
      ...EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST,
      authority,
      scope_profile_id: EMAIL_LUNA_CONTROLLED_DRAFTING_SCOPE_VERSION,
    });
  }

  async function createReplyDraft(input) {
    const request = readCreateRequest(input);
    if (!request || !matchAuthority(authority, request)) throw invalid();
    let innerResult;
    try {
      innerResult = await transport.createReplyDraft(copyKeys(CREATE_INNER_KEYS, request));
    } catch (error) {
      if (error && error.code === ERROR_CODE && objectIsFrozen(error)) throw error;
      throw invalid();
    }
    const result = readTransportResult(innerResult);
    if (!result) throw invalid();
    if (buildMessagePath(request.mailbox_id, result.provider_draft_id, 'get') === null) throw invalid();
    return freezeExact(EMAIL_LUNA_CONTROLLED_DRAFTING_CREATE_RESPONSE_KEYS, {
      outcome: 'draft_created',
      ...request,
      provider_draft_id: result.provider_draft_id,
    });
  }

  async function reconcileDraft(input) {
    const request = readReconcileRequest(input);
    if (!request || !matchAuthority(authority, request)) throw invalid();
    let innerResult;
    try {
      innerResult = await transport.reconcileDraft(copyKeys(RECONCILE_INNER_KEYS, request));
    } catch (error) {
      if (error && error.code === ERROR_CODE && objectIsFrozen(error)) throw error;
      throw invalid();
    }
    const result = readReconcileTransportResult(innerResult);
    if (!result) throw invalid();
    if (result.kind === 'not_found') {
      return freezeExact(EMAIL_LUNA_CONTROLLED_DRAFTING_RECONCILE_RESPONSE_KEYS, {
        outcome: 'draft_not_found',
        ...request,
        is_draft: false,
      });
    }
    if (result.provider_draft_id !== request.provider_draft_id) throw invalid();
    if (result.kind === 'mismatch' || result.is_draft !== true) {
      return freezeExact(EMAIL_LUNA_CONTROLLED_DRAFTING_RECONCILE_RESPONSE_KEYS, {
        outcome: 'draft_mismatch',
        ...request,
        is_draft: false,
      });
    }
    const digestMismatch = (result.subject_digest && result.subject_digest !== request.subject_digest)
      || (result.body_digest && result.body_digest !== request.body_digest);
    const bindingMismatch = (result.recipient_address && result.recipient_address !== request.recipient_address)
      || (result.inbound_provider_thread_id
        && result.inbound_provider_thread_id !== request.inbound_provider_thread_id)
      || (result.mailbox_id && result.mailbox_id !== request.mailbox_id);
    if (bindingMismatch) {
      return freezeExact(EMAIL_LUNA_CONTROLLED_DRAFTING_RECONCILE_RESPONSE_KEYS, {
        outcome: 'draft_mismatch',
        ...request,
        is_draft: true,
      });
    }
    if (digestMismatch) {
      return freezeExact(EMAIL_LUNA_CONTROLLED_DRAFTING_RECONCILE_RESPONSE_KEYS, {
        outcome: 'draft_modified',
        ...request,
        is_draft: true,
      });
    }
    return freezeExact(EMAIL_LUNA_CONTROLLED_DRAFTING_RECONCILE_RESPONSE_KEYS, {
      outcome: 'draft_present',
      ...request,
      is_draft: true,
    });
  }

  const provider = objectFreeze({
    attest,
    createReplyDraft,
    reconcileDraft,
  });
  const surface = reflectOwnKeys(provider);
  if (surface.length !== PROVIDER_SURFACE_KEYS.length) throw invalid();
  for (let i = 0; i < PROVIDER_SURFACE_KEYS.length; i += 1) {
    if (!arrayIncludes(surface, PROVIDER_SURFACE_KEYS[i])) throw invalid();
  }
  return provider;
}

module.exports = objectFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_WIRED,
  EMAIL_LUNA_CONTROLLED_DRAFTING_ACTIVATION,
  EMAIL_LUNA_CONTROLLED_DRAFTING_LOGGING_FORBIDDEN,
  EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER,
  EMAIL_LUNA_CONTROLLED_DRAFTING_LOCATION_KEY,
  EMAIL_LUNA_CONTROLLED_DRAFTING_SCOPE_VERSION,
  EMAIL_LUNA_CONTROLLED_DRAFTING_OPERATIONS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_GRAPH_CALL_OPERATIONS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_TRANSPORT_KEYS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_AUTHORITY_KEYS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_CREATE_REQUEST_KEYS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_CREATE_RESPONSE_KEYS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RECONCILE_REQUEST_KEYS,
  EMAIL_LUNA_CONTROLLED_DRAFTING_RECONCILE_RESPONSE_KEYS,
  RECONCILE_OUTCOMES,
  EMAIL_LUNA_CONTROLLED_DRAFTING_CAPABILITY_MANIFEST,
  EMAIL_MS_CONTROLLED_DRAFTING_SCOPE_PROFILE,
  EMAIL_MS_CONTROLLED_DRAFTING_PROVIDER_FACTS,
  createEmailLunaControlledDraftingProvider,
  createEmailLunaControlledDraftingFakeTransport,
  pickEmailLunaControlledDraftingTransportMethods,
  resolveControlledDraftingGraphCall,
  validateControlledDraftingScopeProfile,
  validateControlledDraftingTokenResponseScope,
  attestEmailLunaControlledDraftingCapabilities,
});
