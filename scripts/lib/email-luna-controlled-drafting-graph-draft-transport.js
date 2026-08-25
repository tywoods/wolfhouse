'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 1 live Graph mapping.
 *
 * Draft-only Microsoft Graph HTTP consumer: POST createReply → PATCH that draft →
 * GET exact observations. No send, sendMail, generic path, or token export.
 * The access token is accepted only by this privately bound consumer; results
 * and errors are sanitized so the token cannot be retained, returned, or thrown.
 * Gate 3 reply-draft transport remains the staff send owner and is not reused
 * as this package's surface.
 */

const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const stream = require('node:stream');
const {
  HOST,
  PREFER_IMMUTABLE_ID,
  buildCreateReplyPath,
  buildMessagePath,
} = require('./email-microsoft-graph-reply-draft-transport');
const {
  isProxySurface,
  ownData,
  exactOwnData,
  subsetOwnData,
  isCanonUuid,
  digestUtf8,
} = require('./email-luna-controlled-drafting-closed-data');

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const objectFreeze = Object.freeze;
const objectCreate = Object.create;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectHasOwn = Object.hasOwn;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const regexpTest = uncurryThis(RegExp.prototype.test);

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_PROVIDER_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting provider failed.';
const DEADLINE_MS = 10_000;
const RESPONSE_CAP_BYTES = 65_536;
const TOKEN_LIMIT = 16_384;
const STRING_LIMIT = 2048;
const BODY_LIMIT = 64_000;
const SUBJECT_LIMIT = 998;
const GRAPH_ID_RE = /^[\x21-\x7e]+$/;
const RECIPIENT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMAIL_LUNA_CONTROLLED_DRAFTING_GET_SELECT = 'id,isDraft,subject,body,toRecipients,conversationId';
const GRAPH_DRAFT_ALLOWED_KEYS = objectFreeze([
  'id', 'isDraft', 'subject', 'body', 'toRecipients', 'conversationId',
  '@odata.context', '@odata.etag', '@odata.type',
]);
const GRAPH_DRAFT_REQUIRED_KEYS = objectFreeze([
  'id', 'isDraft', 'subject', 'body', 'toRecipients', 'conversationId',
]);
const BODY_KEYS = objectFreeze(['contentType', 'content']);
const EMAIL_ADDRESS_ALLOWED = objectFreeze(['address', 'name']);
const RECIPIENT_ALLOWED = objectFreeze(['emailAddress', '@odata.type']);
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
const FACTORY_KEYS = objectFreeze(['httpsImpl', 'timers']);
const TIMER_KEYS = objectFreeze(['setTimeout', 'clearTimeout']);
const TRANSPORT_KEYS = objectFreeze(['createReplyDraft', 'reconcileDraft']);
const GRAPH_OPERATION_KEYS = objectFreeze(['kind', 'command']);
const GRAPH_OPERATION_KINDS = objectFreeze(['create_reply_draft', 'reconcile_draft']);
const FORBIDDEN_FACTORY_KEYS = objectFreeze([
  'tokenLoan', 'getAccessToken', 'runClosed', 'withToken', 'accessToken',
  'consumer', 'callback', 'fetch', 'request', 'client',
]);
const KNOWN_CREATE_IDS = new WeakMap();

const PINNED_IM = http.IncomingMessage;
const PINNED_IM_PROTO = PINNED_IM && PINNED_IM.prototype ? PINNED_IM.prototype : null;
const PINNED_HDR_DESC = PINNED_IM_PROTO ? Object.getOwnPropertyDescriptor(PINNED_IM_PROTO, 'headers') : null;
const PINNED_HDR_GET = PINNED_HDR_DESC && typeof PINNED_HDR_DESC.get === 'function'
  && !Object.prototype.hasOwnProperty.call(PINNED_HDR_DESC, 'value')
  ? PINNED_HDR_DESC.get
  : null;

function pinProto(proto, name) {
  try {
    if (!proto) return null;
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || typeof d.value !== 'function' || d.get || d.set) {
      return null;
    }
    return d.value;
  } catch (_) {
    return null;
  }
}

const SAFE_LC = new Set();
for (const proto of [
  EventEmitter && EventEmitter.prototype,
  stream.Readable && stream.Readable.prototype,
  http.OutgoingMessage && http.OutgoingMessage.prototype,
  http.ClientRequest && http.ClientRequest.prototype,
].filter(Boolean)) {
  for (const name of ['on', 'once', 'end', 'destroy']) {
    const fn = pinProto(proto, name);
    if (fn) SAFE_LC.add(fn);
  }
}

function invalid() {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  objectFreeze(error);
  return error;
}

function unknownCreateError(providerDraftId) {
  const error = invalid();
  if (typeof providerDraftId === 'string') KNOWN_CREATE_IDS.set(error, providerDraftId);
  return error;
}

function readControlledDraftingKnownCreateDraftId(error) {
  try {
    const id = KNOWN_CREATE_IDS.get(error);
    return typeof id === 'string' ? id : null;
  } catch (_) {
    return null;
  }
}

function brandControlledDraftingKnownCreateDraftId(error, providerDraftId) {
  try {
    if (error && typeof providerDraftId === 'string') KNOWN_CREATE_IDS.set(error, providerDraftId);
  } catch (_) { /* */ }
  return error;
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

function buildControlledDraftingGetPath(mailboxId, draftId) {
  const base = buildMessagePath(mailboxId, draftId, 'patch');
  if (!base) return null;
  return `${base}?$select=${EMAIL_LUNA_CONTROLLED_DRAFTING_GET_SELECT}`;
}

function readAccessToken(token) {
  if (typeof token !== 'string' || token.length < 1 || token.length > TOKEN_LIMIT || !/^[\x21-\x7e]+$/.test(token)) {
    return null;
  }
  return token;
}

function resultContainsSecret(result, token) {
  if (typeof token !== 'string' || token.length < 1) return false;
  try {
    if (typeof result === 'string') return result.includes(token);
    if (result && typeof result === 'object') {
      return JSON.stringify(result).includes(token);
    }
  } catch (_) {
    return true;
  }
  return false;
}

function errorContainsSecret(error, token) {
  if (typeof token !== 'string' || token.length < 1 || error == null) return false;
  try {
    if (typeof error === 'string') return error.includes(token);
    const message = ownData(error, 'message');
    if (typeof message === 'string' && message.includes(token)) return true;
    return JSON.stringify(error).includes(token);
  } catch (_) {
    return true;
  }
}

function resolveLc(surface, name) {
  try {
    if (surface == null || (typeof surface !== 'object' && typeof surface !== 'function') || isProxySurface(surface)) {
      return null;
    }
    for (const n of ['on', 'once', 'end', 'destroy']) {
      const d = objectGetOwnPropertyDescriptor(surface, n);
      if (d && (d.get || d.set)) return null;
    }
    const own = objectGetOwnPropertyDescriptor(surface, name);
    if (own) {
      return objectHasOwn(own, 'value') && typeof own.value === 'function' && !own.get && !own.set
        ? own.value
        : null;
    }
    let proto = Object.getPrototypeOf(surface);
    while (proto && proto !== Object.prototype) {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (d) {
        if (!objectHasOwn(d, 'value') || typeof d.value !== 'function' || d.get || d.set) return null;
        return SAFE_LC.has(d.value) ? d.value : null;
      }
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  } catch (_) {
    return null;
  }
}

function applyLc(surface, name, args) {
  const fn = resolveLc(surface, name);
  if (typeof fn !== 'function') return false;
  Reflect.apply(fn, surface, args);
  return true;
}

function readResponseHeaders(response) {
  try {
    if (PINNED_IM && PINNED_HDR_GET && response instanceof PINNED_IM) {
      const h = Reflect.apply(PINNED_HDR_GET, response, []);
      return h && typeof h === 'object' && !isProxySurface(h) ? h : null;
    }
    const h = ownData(response, 'headers');
    return h && typeof h === 'object' && !isProxySurface(h) ? h : null;
  } catch (_) {
    return null;
  }
}

function issueGraphRequest(opts) {
  const {
    requestFn, setTimer, clearTimer, method, path, token, bodyText, prefer,
    successStatuses, notFoundIsRemoved,
  } = opts;
  return new Promise((resolve, reject) => {
    let settled = false;
    let requestObject;
    let activeResponse;
    let timerHandle;
    let timerAcquired = false;
    let timerCleared = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timerAcquired && !timerCleared) {
        timerCleared = true;
        try { clearTimer(timerHandle); } catch (_) { /* */ }
      }
      if (error) reject(error);
      else resolve(result);
    };
    const destroyRequest = () => {
      try { if (requestObject) applyLc(requestObject, 'destroy', []); } catch (_) { /* */ }
    };
    const destroyResponse = () => {
      try { if (activeResponse) applyLc(activeResponse, 'destroy', []); } catch (_) { /* */ }
    };
    const terminate = () => {
      destroyResponse();
      destroyRequest();
      finish(invalid());
    };
    try {
      timerHandle = setTimer(() => terminate(), DEADLINE_MS);
      timerAcquired = true;
    } catch (_) {
      finish(invalid());
      return;
    }
    if (settled) return;
    const headers = { Accept: 'application/json', Authorization: ['Bearer', token].join(' ') };
    if (prefer) headers.Prefer = prefer;
    if (bodyText !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyText, 'utf8');
    }
    try {
      requestObject = requestFn({
        protocol: 'https:',
        hostname: HOST,
        host: HOST,
        port: 443,
        method,
        path,
        agent: false,
        headers,
      }, (response) => {
        if (isProxySurface(response)) {
          if (settled) return;
          destroyRequest();
          finish(invalid());
          return;
        }
        if (settled) {
          activeResponse = response;
          destroyResponse();
          return;
        }
        activeResponse = response;
        try {
          const status = ownData(response, 'statusCode');
          const rh = readResponseHeaders(response);
          const contentType = rh && typeof rh === 'object' ? ownData(rh, 'content-type') : undefined;
          if (typeof status !== 'number' || !successStatuses.includes(status)) {
            if (status === 404 && notFoundIsRemoved === true) {
              destroyResponse();
              destroyRequest();
              finish(null, objectFreeze({ found: false }));
              return;
            }
            terminate();
            return;
          }
          if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
            terminate();
            return;
          }
          const onFn = resolveLc(response, 'on');
          const onceFn = resolveLc(response, 'once');
          if (typeof onFn !== 'function' || typeof onceFn !== 'function') {
            terminate();
            return;
          }
          const chunks = [];
          let bytes = 0;
          let ended = false;
          Reflect.apply(onFn, response, ['data', (chunk) => {
            if (settled) return;
            if (!Buffer.isBuffer(chunk)) {
              terminate();
              return;
            }
            if (chunk.length > RESPONSE_CAP_BYTES - bytes) {
              terminate();
              return;
            }
            bytes += chunk.length;
            chunks.push(chunk);
          }]);
          Reflect.apply(onceFn, response, ['error', () => terminate()]);
          Reflect.apply(onceFn, response, ['aborted', () => terminate()]);
          Reflect.apply(onceFn, response, ['close', () => {
            if (!ended && !settled) terminate();
          }]);
          Reflect.apply(onceFn, response, ['end', () => {
            if (settled) return;
            ended = true;
            try {
              let parsed;
              try {
                parsed = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
              } catch (_) {
                terminate();
                return;
              }
              destroyRequest();
              finish(null, parsed);
            } catch (_) {
              terminate();
            }
          }]);
        } catch (_) {
          terminate();
        }
      });
      if (settled) {
        destroyRequest();
        return;
      }
      const onceReq = resolveLc(requestObject, 'once');
      const endReq = resolveLc(requestObject, 'end');
      if (typeof onceReq !== 'function' || typeof endReq !== 'function') {
        terminate();
        return;
      }
      Reflect.apply(onceReq, requestObject, ['error', () => terminate()]);
      if (bodyText !== null) Reflect.apply(endReq, requestObject, [bodyText]);
      else Reflect.apply(endReq, requestObject, []);
    } catch (_) {
      terminate();
    }
  });
}

function readCreatePostBody(parsed) {
  if (!parsed || typeof parsed !== 'object' || arrayIsArray(parsed) || isProxySurface(parsed)) return null;
  const id = ownData(parsed, 'id');
  const isDraft = ownData(parsed, 'isDraft');
  if (!isGraphId(id) || isDraft !== true) return null;
  return objectFreeze({ provider_draft_id: id, is_draft: true });
}

function readEmailAddress(raw) {
  const parsed = subsetOwnData(raw, EMAIL_ADDRESS_ALLOWED);
  if (!parsed || typeof parsed.address !== 'string') return null;
  const address = parsed.address.trim().toLowerCase();
  if (!isRecipient(address)) return null;
  return address;
}

function readRecipientRow(raw) {
  const parsed = subsetOwnData(raw, RECIPIENT_ALLOWED);
  if (!parsed || !objectHasOwn(parsed, 'emailAddress')) return null;
  return readEmailAddress(parsed.emailAddress);
}

function readBodyText(raw) {
  const parsed = exactOwnData(raw, BODY_KEYS);
  if (!parsed) return null;
  const contentType = parsed.contentType;
  if (contentType !== 'Text' && contentType !== 'text') return null;
  if (typeof parsed.content !== 'string' || parsed.content.length < 1 || parsed.content.length > BODY_LIMIT) {
    return null;
  }
  return parsed.content;
}

function mapGraphDraftObservation(parsed, expected) {
  if (parsed && parsed.found === false && reflectOwnKeys(parsed).length === 1) {
    return objectFreeze({ kind: 'not_found' });
  }
  const row = subsetOwnData(parsed, GRAPH_DRAFT_ALLOWED_KEYS);
  if (!row) return objectFreeze({ kind: 'unusable' });
  for (let i = 0; i < GRAPH_DRAFT_REQUIRED_KEYS.length; i += 1) {
    if (!objectHasOwn(row, GRAPH_DRAFT_REQUIRED_KEYS[i])) return objectFreeze({ kind: 'unusable' });
  }
  const id = row.id;
  if (!isGraphId(id) || id !== expected.provider_draft_id) return objectFreeze({ kind: 'unusable' });
  if (row.isDraft === false) {
    return objectFreeze({
      kind: 'sent',
      provider_draft_id: id,
      is_draft: false,
    });
  }
  if (row.isDraft !== true) return objectFreeze({ kind: 'unusable' });
  if (typeof row.subject !== 'string' || row.subject.length < 1 || row.subject.length > SUBJECT_LIMIT
      || /[\x00-\x1f\x7f]/.test(row.subject)) {
    return objectFreeze({ kind: 'unusable' });
  }
  const bodyText = readBodyText(row.body);
  if (bodyText === null) return objectFreeze({ kind: 'unusable' });
  if (!arrayIsArray(row.toRecipients) || isProxySurface(row.toRecipients)) {
    return objectFreeze({ kind: 'unusable' });
  }
  if (row.toRecipients.length !== 1) {
    return objectFreeze({
      kind: 'mismatch',
      provider_draft_id: id,
      is_draft: true,
    });
  }
  const recipient = readRecipientRow(row.toRecipients[0]);
  if (recipient === null) {
    return objectFreeze({
      kind: 'mismatch',
      provider_draft_id: id,
      is_draft: true,
    });
  }
  if (!isGraphId(row.conversationId)) return objectFreeze({ kind: 'unusable' });
  const subjectDigest = digestUtf8(row.subject);
  const bodyDigest = digestUtf8(bodyText);
  if (!subjectDigest || !bodyDigest) return objectFreeze({ kind: 'unusable' });
  return objectFreeze({
    kind: 'present',
    provider_draft_id: id,
    is_draft: true,
    subject_digest: subjectDigest,
    body_digest: bodyDigest,
    recipient_address: recipient,
    inbound_provider_thread_id: row.conversationId,
    mailbox_id: expected.mailbox_id,
  });
}

function observationToTransportResult(mapped) {
  if (!mapped) return null;
  if (mapped.kind === 'not_found') return objectFreeze({ found: false });
  if (mapped.kind === 'sent') {
    return objectFreeze({
      provider_draft_id: mapped.provider_draft_id,
      is_draft: false,
    });
  }
  if (mapped.kind === 'present') {
    return objectFreeze({
      provider_draft_id: mapped.provider_draft_id,
      is_draft: true,
      subject_digest: mapped.subject_digest,
      body_digest: mapped.body_digest,
      recipient_address: mapped.recipient_address,
      inbound_provider_thread_id: mapped.inbound_provider_thread_id,
      mailbox_id: mapped.mailbox_id,
    });
  }
  if (mapped.kind === 'mismatch' && mapped.provider_draft_id) {
    return objectFreeze({
      provider_draft_id: mapped.provider_draft_id,
      is_draft: mapped.is_draft === true,
      observation_unusable: true,
    });
  }
  return null;
}

function resolveFactory(dependencies) {
  if (dependencies && typeof dependencies === 'object' && !arrayIsArray(dependencies)) {
    const keys = reflectOwnKeys(dependencies);
    for (let i = 0; i < keys.length; i += 1) {
      if (FORBIDDEN_FACTORY_KEYS.includes(keys[i])) throw invalid();
    }
  }
  const parsed = subsetOwnData(dependencies, FACTORY_KEYS);
  if (!parsed) throw invalid();
  let requestFn;
  if (parsed.httpsImpl === undefined) requestFn = https.request;
  else if (typeof parsed.httpsImpl === 'function' && !isProxySurface(parsed.httpsImpl)) requestFn = parsed.httpsImpl;
  else throw invalid();
  let setTimer = setTimeout;
  let clearTimer = clearTimeout;
  if (objectHasOwn(parsed, 'timers')) {
    const timers = exactOwnData(parsed.timers, TIMER_KEYS);
    if (!timers) throw invalid();
    setTimer = timers.setTimeout;
    clearTimer = timers.clearTimeout;
    if (typeof setTimer !== 'function' || typeof clearTimer !== 'function'
        || isProxySurface(setTimer) || isProxySurface(clearTimer)) {
      throw invalid();
    }
  }
  return { requestFn, setTimer, clearTimer };
}

async function runCreateReplyDraft(ctx, token, input) {
  const command = exactOwnData(input, CREATE_INNER_KEYS);
  if (!command) throw invalid();
  if (!isCanonUuid(command.mailbox_id) || !isGraphId(command.inbound_provider_message_id)) {
    throw invalid();
  }
  const createPath = buildCreateReplyPath(command.mailbox_id, command.inbound_provider_message_id);
  if (!createPath) throw invalid();
  let created;
  try {
    created = await issueGraphRequest({
      requestFn: ctx.requestFn,
      setTimer: ctx.setTimer,
      clearTimer: ctx.clearTimer,
      method: 'POST',
      path: createPath,
      token,
      bodyText: '{}',
      prefer: PREFER_IMMUTABLE_ID,
      successStatuses: [200, 201],
      notFoundIsRemoved: false,
    });
  } catch (error) {
    if (error && error.code === ERROR_CODE) throw error;
    throw invalid();
  }
  const posted = readCreatePostBody(created);
  if (!posted) throw invalid();
  const draftId = posted.provider_draft_id;
  const patchPath = buildMessagePath(command.mailbox_id, draftId, 'patch');
  const getPath = buildControlledDraftingGetPath(command.mailbox_id, draftId);
  if (!patchPath || !getPath) throw unknownCreateError(draftId);
  let patchBody;
  try {
    patchBody = JSON.stringify({
      subject: command.subject,
      body: { contentType: 'Text', content: command.body_text },
      toRecipients: [{ emailAddress: { address: command.recipient_address } }],
    });
  } catch (_) {
    throw unknownCreateError(draftId);
  }
  try {
    await issueGraphRequest({
      requestFn: ctx.requestFn,
      setTimer: ctx.setTimer,
      clearTimer: ctx.clearTimer,
      method: 'PATCH',
      path: patchPath,
      token,
      bodyText: patchBody,
      prefer: PREFER_IMMUTABLE_ID,
      successStatuses: [200],
      notFoundIsRemoved: false,
    });
  } catch (_) {
    throw unknownCreateError(draftId);
  }
  let got;
  try {
    got = await issueGraphRequest({
      requestFn: ctx.requestFn,
      setTimer: ctx.setTimer,
      clearTimer: ctx.clearTimer,
      method: 'GET',
      path: getPath,
      token,
      bodyText: null,
      prefer: `${PREFER_IMMUTABLE_ID}, outlook.body-content-type="text"`,
      successStatuses: [200],
      notFoundIsRemoved: true,
    });
  } catch (_) {
    throw unknownCreateError(draftId);
  }
  const mapped = mapGraphDraftObservation(got, {
    provider_draft_id: draftId,
    mailbox_id: command.mailbox_id,
  });
  const result = observationToTransportResult(mapped);
  if (!result || result.found === false || result.is_draft !== true || result.observation_unusable === true) {
    throw unknownCreateError(draftId);
  }
  if (result.mailbox_id !== command.mailbox_id) throw unknownCreateError(draftId);
  return objectFreeze({
    provider_draft_id: result.provider_draft_id,
    is_draft: true,
    subject_digest: result.subject_digest,
    body_digest: result.body_digest,
    recipient_address: result.recipient_address,
    inbound_provider_thread_id: result.inbound_provider_thread_id,
    mailbox_id: result.mailbox_id,
  });
}

async function runReconcileDraft(ctx, token, input) {
  const command = exactOwnData(input, RECONCILE_INNER_KEYS);
  if (!command) throw invalid();
  const getPath = buildControlledDraftingGetPath(command.mailbox_id, command.provider_draft_id);
  if (!getPath) throw invalid();
  let got;
  try {
    got = await issueGraphRequest({
      requestFn: ctx.requestFn,
      setTimer: ctx.setTimer,
      clearTimer: ctx.clearTimer,
      method: 'GET',
      path: getPath,
      token,
      bodyText: null,
      prefer: `${PREFER_IMMUTABLE_ID}, outlook.body-content-type="text"`,
      successStatuses: [200],
      notFoundIsRemoved: true,
    });
  } catch (error) {
    if (error && error.code === ERROR_CODE) throw error;
    throw invalid();
  }
  const mappedInner = mapGraphDraftObservation(got, {
    provider_draft_id: command.provider_draft_id,
    mailbox_id: command.mailbox_id,
  });
  const resultInner = observationToTransportResult(mappedInner);
  if (!resultInner) {
    return objectFreeze({
      provider_draft_id: command.provider_draft_id,
      is_draft: true,
      observation_unusable: true,
    });
  }
  return resultInner;
}

function createEmailLunaControlledDraftingGraphDraftHttpConsumer(dependencies) {
  const resolved = resolveFactory(dependencies);

  async function consumeGraphDraft(accessToken, operation) {
    let token = readAccessToken(accessToken);
    try {
      if (!token) throw invalid();
      const op = exactOwnData(operation, GRAPH_OPERATION_KEYS);
      if (!op || !GRAPH_OPERATION_KINDS.includes(op.kind)) throw invalid();
      let result;
      if (op.kind === 'create_reply_draft') {
        result = await runCreateReplyDraft(resolved, token, op.command);
      } else {
        result = await runReconcileDraft(resolved, token, op.command);
      }
      if (resultContainsSecret(result, token)) throw invalid();
      return result;
    } catch (error) {
      if (errorContainsSecret(error, token)) throw invalid();
      throw error;
    } finally {
      token = null;
      accessToken = null;
    }
  }

  return consumeGraphDraft;
}

function createEmailLunaControlledDraftingGraphDraftTransport(dependencies) {
  throw invalid();
}

module.exports = objectFreeze({
  EMAIL_LUNA_CONTROLLED_DRAFTING_GET_SELECT,
  GRAPH_OPERATION_KEYS,
  GRAPH_OPERATION_KINDS,
  buildControlledDraftingGetPath,
  mapGraphDraftObservation,
  createEmailLunaControlledDraftingGraphDraftHttpConsumer,
  createEmailLunaControlledDraftingGraphDraftTransport,
  readControlledDraftingKnownCreateDraftId,
  brandControlledDraftingKnownCreateDraftId,
});
