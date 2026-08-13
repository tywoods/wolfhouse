'use strict';
/** Graph reply-draft transport (Gate 3, UNWIRED). createReply→update→send≤1→reconcile. */
const http = require('http');
const https = require('https');
const util = require('util');
const { EventEmitter } = require('events');
const stream = require('stream');
const HOST = 'graph.microsoft.com';
const PREFER_IMMUTABLE_ID = 'IdType="ImmutableId"';
const DEADLINE_MS = 10_000; const RESPONSE_CAP_BYTES = 65_536; const TOKEN_LIMIT = 16_384;
const STRING_LIMIT = 2048; const BODY_CONTENT_LIMIT = 64_000;
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FAILURE_CODE = 'microsoft_graph_reply_draft_failed';
const FAILURE_MESSAGE = 'Microsoft Graph reply-draft request failed.';
const DEPENDENCY_KEYS = Object.freeze(['httpsImpl', 'timers']);
const TIMER_KEYS = Object.freeze(['setTimeout', 'clearTimeout']);
const GRAPH_STAGES = Object.freeze(['request_error','deadline_exceeded','response_surface_invalid','http_status_not_success','response_too_large','json_invalid','row_value_invalid','outcome_unknown']);
const EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_RUNTIME_WIRED = false;
const EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_PERSISTENCE_READY = false;
const EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_LOGGING_FORBIDDEN = true;
const EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_PINS_PREFER_IMMUTABLE_ID = true;
const EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_DELIVERY_FROM_202 = false;
const PINNED_IM = http.IncomingMessage;
const PINNED_IM_PROTO = PINNED_IM && PINNED_IM.prototype ? PINNED_IM.prototype : null;
const PINNED_HDR_DESC = PINNED_IM_PROTO ? Object.getOwnPropertyDescriptor(PINNED_IM_PROTO, 'headers') : null;
const PINNED_HDR_GET = PINNED_HDR_DESC && typeof PINNED_HDR_DESC.get === 'function' && !Object.prototype.hasOwnProperty.call(PINNED_HDR_DESC, 'value') ? PINNED_HDR_DESC.get : null;
const PINNED_TYPES = util.types && typeof util.types === 'object' ? util.types : null;
const PINNED_IS_PROXY = PINNED_TYPES && typeof PINNED_TYPES.isProxy === 'function' ? PINNED_TYPES.isProxy : null;
function pinProto(proto, name) {
  try {
    if (!proto) return null;
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || typeof d.value !== 'function' || d.get || d.set) return null;
    return d.value;
  } catch { return null; }
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
const STAGE_BRAND = new WeakMap();
function ownData(o, k) {
  try {
    const d = Object.getOwnPropertyDescriptor(o, k);
    return d && Object.prototype.hasOwnProperty.call(d, 'value') && !d.get && !d.set ? d.value : undefined;
  } catch { return undefined; }
}
function isProxySurface(v) {
  try { if (!PINNED_IS_PROXY || !PINNED_TYPES) return true; return Reflect.apply(PINNED_IS_PROXY, PINNED_TYPES, [v]) === true; }
  catch { return true; }
}
function exactPlainData(o, keys) {
  try {
    if (!o || typeof o !== 'object' || Array.isArray(o) || isProxySurface(o) || Object.getPrototypeOf(o) !== Object.prototype) return false;
    const actual = Reflect.ownKeys(o);
    if (actual.length !== keys.length || actual.some((k) => typeof k !== 'string' || !keys.includes(k))) return false;
    return keys.every((k) => {
      const d = Object.getOwnPropertyDescriptor(o, k);
      return Boolean(d && Object.prototype.hasOwnProperty.call(d, 'value') && !d.get && !d.set);
    });
  } catch { return false; }
}
function failure(stage) {
  const error = new Error(FAILURE_MESSAGE);
  Object.defineProperty(error, 'name', { value: 'MicrosoftGraphReplyDraftError' });
  Object.defineProperty(error, 'code', { value: FAILURE_CODE, enumerable: true });
  Object.freeze(error);
  STAGE_BRAND.set(error, GRAPH_STAGES.includes(stage) ? stage : 'request_error');
  return error;
}
function readTrustedGraphStage(error) {
  try {
    if (!error || (typeof error !== 'object' && typeof error !== 'function')) return null;
    const s = STAGE_BRAND.get(error); return typeof s === 'string' ? s : null;
  } catch { return null; }
}
function readResponseHeaders(response) {
  try {
    if (PINNED_IM && PINNED_HDR_GET && response instanceof PINNED_IM) {
      const h = Reflect.apply(PINNED_HDR_GET, response, []);
      return h && typeof h === 'object' && !isProxySurface(h) ? h : null;
    }
    const h = ownData(response, 'headers');
    return h && typeof h === 'object' && !isProxySurface(h) ? h : null;
  } catch { return null; }
}
function resolveLc(surface, name) {
  try {
    if (surface == null || (typeof surface !== 'object' && typeof surface !== 'function') || isProxySurface(surface)) return null;
    for (const n of ['on', 'once', 'end', 'destroy']) {
      const d = Object.getOwnPropertyDescriptor(surface, n);
      if (d && (d.get || d.set)) return null;
    }
    const own = Object.getOwnPropertyDescriptor(surface, name);
    if (own) {
      return Object.prototype.hasOwnProperty.call(own, 'value') && typeof own.value === 'function' && !own.get && !own.set ? own.value : null;
    }
    let proto = Object.getPrototypeOf(surface);
    while (proto && proto !== Object.prototype) {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (d) {
        if (!Object.prototype.hasOwnProperty.call(d, 'value') || typeof d.value !== 'function' || d.get || d.set) return null;
        return SAFE_LC.has(d.value) ? d.value : null;
      }
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  } catch { return null; }
}
function applyLc(surface, name, args) {
  const fn = resolveLc(surface, name);
  if (typeof fn !== 'function') return false;
  Reflect.apply(fn, surface, args); return true;
}
function isCanonUuid(v) { return typeof v === 'string' && UUID_CANON.test(v); }
function encodePathSegment(id) {
  if (typeof id !== 'string' || id.length < 1 || id.length > STRING_LIMIT) return null;
  if (!/^[\x21-\x7e]+$/.test(id) || /[/?#]/.test(id)) return null;
  try { return encodeURIComponent(id); } catch { return null; }
}
function buildCreateReplyPath(mailboxId, sourceMessageId) {
  if (!isCanonUuid(mailboxId)) return null;
  const seg = encodePathSegment(sourceMessageId);
  return seg ? `/v1.0/users/${mailboxId}/messages/${seg}/createReply` : null;
}
function buildMessagePath(mailboxId, draftId, suffix) {
  if (!isCanonUuid(mailboxId) || typeof suffix !== 'string') return null;
  const seg = encodePathSegment(draftId); if (!seg) return null;
  const base = `/v1.0/users/${mailboxId}/messages/${seg}`;
  if (suffix === 'send') return `${base}/send`;
  if (suffix === 'get') return `${base}?$select=id,isDraft`;
  if (suffix === 'patch') return base;
  return null;
}
function buildSendMailPath(mailboxId) {
  if (!isCanonUuid(mailboxId)) return null;
  return `/v1.0/users/${mailboxId}/sendMail`;
}
const SENDMAIL_TO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENDMAIL_TO_MAX = 160;
const SENDMAIL_SUBJECT_MAX = 200;
const REPLY_DRAFT_METHOD_KEYS = Object.freeze(['createReply', 'updateApprovedDraft', 'sendDraft', 'reconcileDraft']);
function pickReplyDraftTransportMethods(transport) {
  try {
    if (!transport || typeof transport !== 'object') return null;
    const out = {};
    for (const k of REPLY_DRAFT_METHOD_KEYS) {
      const fn = ownData(transport, k);
      if (typeof fn !== 'function') return null;
      out[k] = fn;
    }
    return Object.freeze(out);
  } catch { return null; }
}
function scrubToken(holder) {
  try {
    if (holder == null || (typeof holder !== 'object' && typeof holder !== 'function') || isProxySurface(holder)) return;
    const d = Object.getOwnPropertyDescriptor(holder, 'accessToken');
    if (!d || d.get || d.set || !Object.prototype.hasOwnProperty.call(d, 'value')) return;
    try { holder.accessToken = null; } catch { /* */ }
  } catch { /* */ }
}
function readTokenMailbox(input, extraKeys) {
  const keys = ['accessToken', 'provider_mailbox_id', ...extraKeys];
  if (!exactPlainData(input, keys)) { scrubToken(input); return null; }
  const token = ownData(input, 'accessToken'); const mailbox = ownData(input, 'provider_mailbox_id');
  if (typeof token !== 'string' || token.length < 1 || token.length > TOKEN_LIMIT || !/^[\x21-\x7e]+$/.test(token) || !isCanonUuid(mailbox)) {
    scrubToken(input); return null;
  }
  const out = { accessToken: token, provider_mailbox_id: mailbox };
  for (const k of extraKeys) out[k] = ownData(input, k);
  return out;
}
function resolveDependencies(dependencies) {
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies) || isProxySurface(dependencies) || Object.getPrototypeOf(dependencies) !== Object.prototype) throw failure('request_error');
  for (const key of Reflect.ownKeys(dependencies)) {
    if (typeof key !== 'string' || !DEPENDENCY_KEYS.includes(key)) throw failure('request_error');
    const d = Object.getOwnPropertyDescriptor(dependencies, key);
    if (!d || d.get || d.set || !Object.prototype.hasOwnProperty.call(d, 'value')) throw failure('request_error');
  }
  let requestFn; const httpsImpl = ownData(dependencies, 'httpsImpl');
  if (httpsImpl === undefined) requestFn = https.request;
  else if (typeof httpsImpl === 'function' && !isProxySurface(httpsImpl)) requestFn = httpsImpl;
  else throw failure('request_error');
  let setTimer = setTimeout; let clearTimer = clearTimeout;
  if (Object.prototype.hasOwnProperty.call(dependencies, 'timers')) {
    const timers = ownData(dependencies, 'timers');
    if (!exactPlainData(timers, TIMER_KEYS)) throw failure('request_error');
    setTimer = ownData(timers, 'setTimeout'); clearTimer = ownData(timers, 'clearTimeout');
    if (typeof setTimer !== 'function' || typeof clearTimer !== 'function' || isProxySurface(setTimer) || isProxySurface(clearTimer)) throw failure('request_error');
  }
  return { requestFn, setTimer, clearTimer };
}
function extractDraftId(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || isProxySurface(parsed)) return null;
  const id = ownData(parsed, 'id');
  if (typeof id !== 'string' || id.length < 1 || id.length > STRING_LIMIT || !/^[\x21-\x7e]+$/.test(id)) return null;
  return id;
}
function issueGraphRequest(opts) {
  const { requestFn, setTimer, clearTimer, method, path, token, bodyText, prefer, successStatuses, parseBody, notFoundIsUnknown } = opts;
  return new Promise((resolve, reject) => {
    let settled = false; let requestObject; let activeResponse; let timerHandle; let timerAcquired = false; let timerCleared = false;
    const finish = (error, result) => {
      if (settled) return; settled = true;
      if (timerAcquired && !timerCleared) { timerCleared = true; try { clearTimer(timerHandle); } catch { /* */ } }
      if (error) reject(error); else resolve(result);
    };
    const destroyRequest = () => { try { if (requestObject) applyLc(requestObject, 'destroy', []); } catch { /* */ } };
    const destroyResponse = () => { try { if (activeResponse) applyLc(activeResponse, 'destroy', []); } catch { /* */ } };
    const terminate = (stage) => { destroyResponse(); destroyRequest(); finish(failure(stage)); };
    try { timerHandle = setTimer(() => terminate('deadline_exceeded'), DEADLINE_MS); timerAcquired = true; }
    catch { finish(failure('request_error')); return; }
    if (settled) return;
    const headers = { Accept: 'application/json', Authorization: ['Bearer', token].join(' ') };
    if (prefer) headers.Prefer = prefer;
    if (bodyText !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(bodyText, 'utf8'); }
    try {
      requestObject = requestFn({ protocol: 'https:', hostname: HOST, host: HOST, port: 443, method, path, agent: false, headers }, (response) => {
        if (isProxySurface(response)) { if (settled) return; destroyRequest(); finish(failure('response_surface_invalid')); return; }
        if (settled) { activeResponse = response; destroyResponse(); return; }
        activeResponse = response;
        try {
          const status = ownData(response, 'statusCode');
          const rh = readResponseHeaders(response);
          const contentType = rh && typeof rh === 'object' ? ownData(rh, 'content-type') : undefined;
          if (typeof status !== 'number' || !successStatuses.includes(status)) {
            if (status === 404 && notFoundIsUnknown === true) { terminate('outcome_unknown'); return; }
            terminate('http_status_not_success'); return;
          }
          if (parseBody === null) {
            destroyResponse(); destroyRequest();
            finish(null, Object.freeze({ outcome: 'send_accepted', delivery_claimed: false, http_status: status })); return;
          }
          if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) { terminate('json_invalid'); return; }
          const onFn = resolveLc(response, 'on'); const onceFn = resolveLc(response, 'once');
          if (typeof onFn !== 'function' || typeof onceFn !== 'function') { terminate('response_surface_invalid'); return; }
          const chunks = []; let bytes = 0; let ended = false;
          Reflect.apply(onFn, response, ['data', (chunk) => {
            if (settled) return;
            if (!Buffer.isBuffer(chunk)) { terminate('json_invalid'); return; }
            if (chunk.length > RESPONSE_CAP_BYTES - bytes) { terminate('response_too_large'); return; }
            bytes += chunk.length; chunks.push(chunk);
          }]);
          Reflect.apply(onceFn, response, ['error', () => terminate('request_error')]);
          Reflect.apply(onceFn, response, ['aborted', () => terminate('request_error')]);
          Reflect.apply(onceFn, response, ['close', () => { if (!ended && !settled) terminate('request_error'); }]);
          Reflect.apply(onceFn, response, ['end', () => {
            if (settled) return; ended = true;
            try {
              let parsed; try { parsed = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')); }
              catch { terminate('json_invalid'); return; }
              const mapped = parseBody(parsed, status);
              if (mapped === null) { terminate('row_value_invalid'); return; }
              destroyRequest(); finish(null, mapped);
            } catch { terminate('json_invalid'); }
          }]);
        } catch { terminate('request_error'); }
      });
      if (settled) { destroyRequest(); return; }
      const onceReq = resolveLc(requestObject, 'once'); const endReq = resolveLc(requestObject, 'end');
      if (typeof onceReq !== 'function' || typeof endReq !== 'function') { terminate('request_error'); return; }
      Reflect.apply(onceReq, requestObject, ['error', () => terminate('request_error')]);
      if (bodyText !== null) Reflect.apply(endReq, requestObject, [bodyText]); else Reflect.apply(endReq, requestObject, []);
    } catch { terminate('request_error'); }
  });
}
function createMicrosoftGraphReplyDraftTransport(dependencies = {}) {
  let resolved;
  try { resolved = resolveDependencies(dependencies || {}); }
  catch (err) { if (err && err.code === FAILURE_CODE) throw err; throw failure('request_error'); }
  let sendInvoked = false;
  const base = () => ({ requestFn: resolved.requestFn, setTimer: resolved.setTimer, clearTimer: resolved.clearTimer });
  function createReply(input) {
    const parsed = readTokenMailbox(input, ['source_message_id']);
    if (!parsed) return Promise.reject(failure('request_error'));
    const sourceId = parsed.source_message_id;
    if (typeof sourceId !== 'string' || sourceId.length < 1 || sourceId.length > STRING_LIMIT) { scrubToken(input); return Promise.reject(failure('request_error')); }
    const path = buildCreateReplyPath(parsed.provider_mailbox_id, sourceId);
    if (!path) { scrubToken(input); return Promise.reject(failure('request_error')); }
    const token = parsed.accessToken; parsed.accessToken = null; scrubToken(input);
    return issueGraphRequest({
      ...base(), method: 'POST', path, token, bodyText: '{}', prefer: PREFER_IMMUTABLE_ID, successStatuses: [200, 201],
      parseBody: (body) => { const id = extractDraftId(body); return id === null ? null : Object.freeze({ outcome: 'draft_created', immutable_draft_id: id, isDraft: true }); },
    });
  }
  function updateApprovedDraft(input) {
    const parsed = readTokenMailbox(input, ['immutable_draft_id', 'body_content_type', 'body_content']);
    if (!parsed) return Promise.reject(failure('request_error'));
    const draftId = parsed.immutable_draft_id; const contentType = parsed.body_content_type; const content = parsed.body_content;
    if (typeof draftId !== 'string' || draftId.length < 1 || draftId.length > STRING_LIMIT || (contentType !== 'Text' && contentType !== 'HTML') || typeof content !== 'string' || content.length < 1 || content.length > BODY_CONTENT_LIMIT) {
      scrubToken(input); return Promise.reject(failure('request_error'));
    }
    const path = buildMessagePath(parsed.provider_mailbox_id, draftId, 'patch');
    if (!path) { scrubToken(input); return Promise.reject(failure('request_error')); }
    let bodyText;
    try { bodyText = JSON.stringify({ body: { contentType, content } }); }
    catch { scrubToken(input); return Promise.reject(failure('request_error')); }
    const token = parsed.accessToken; parsed.accessToken = null; scrubToken(input); parsed.body_content = null;
    return issueGraphRequest({
      ...base(), method: 'PATCH', path, token, bodyText, prefer: PREFER_IMMUTABLE_ID, successStatuses: [200],
      parseBody: (body) => { const id = extractDraftId(body); return id === null || id !== draftId ? null : Object.freeze({ outcome: 'draft_updated', immutable_draft_id: id }); },
    });
  }
  function sendDraft(input) {
    if (sendInvoked) { scrubToken(input); return Promise.reject(failure('request_error')); }
    sendInvoked = true;
    const parsed = readTokenMailbox(input, ['immutable_draft_id']);
    if (!parsed) return Promise.reject(failure('request_error'));
    const draftId = parsed.immutable_draft_id;
    if (typeof draftId !== 'string' || draftId.length < 1 || draftId.length > STRING_LIMIT) { scrubToken(input); return Promise.reject(failure('request_error')); }
    const path = buildMessagePath(parsed.provider_mailbox_id, draftId, 'send');
    if (!path) { scrubToken(input); return Promise.reject(failure('request_error')); }
    const token = parsed.accessToken; parsed.accessToken = null; scrubToken(input);
    return issueGraphRequest({
      ...base(), method: 'POST', path, token, bodyText: null, prefer: null, successStatuses: [202, 200], parseBody: null,
    }).then((result) => Object.freeze({
      outcome: 'send_accepted', immutable_draft_id: draftId, delivery_claimed: false,
      http_status: result.http_status, requires_reconcile: true,
    }));
  }
  function sendMail(input) {
    const parsed = readTokenMailbox(input, ['to', 'subject', 'body_content_type', 'body_content']);
    if (!parsed) return Promise.reject(failure('request_error'));
    const to = parsed.to;
    const subject = parsed.subject;
    const contentType = parsed.body_content_type;
    const content = parsed.body_content;
    if (typeof to !== 'string' || to.length < 3 || to.length > SENDMAIL_TO_MAX || !SENDMAIL_TO_RE.test(to)
        || typeof subject !== 'string' || subject.length < 1 || subject.length > SENDMAIL_SUBJECT_MAX
        || (contentType !== 'Text' && contentType !== 'HTML')
        || typeof content !== 'string' || content.length < 1 || content.length > BODY_CONTENT_LIMIT) {
      scrubToken(input); return Promise.reject(failure('request_error'));
    }
    const path = buildSendMailPath(parsed.provider_mailbox_id);
    if (!path) { scrubToken(input); return Promise.reject(failure('request_error')); }
    let bodyText;
    try {
      bodyText = JSON.stringify({
        message: {
          subject,
          body: { contentType, content },
          toRecipients: [{ emailAddress: { address: to } }],
        },
        saveToSentItems: true,
      });
    } catch { scrubToken(input); return Promise.reject(failure('request_error')); }
    const token = parsed.accessToken; parsed.accessToken = null; scrubToken(input); parsed.body_content = null;
    return issueGraphRequest({
      ...base(), method: 'POST', path, token, bodyText, prefer: null, successStatuses: [202, 200], parseBody: null,
    }).then((result) => Object.freeze({
      outcome: 'send_accepted', delivery_claimed: false, http_status: result.http_status,
    }));
  }
  function reconcileDraft(input) {
    const parsed = readTokenMailbox(input, ['immutable_draft_id']);
    if (!parsed) return Promise.reject(failure('request_error'));
    const draftId = parsed.immutable_draft_id;
    if (typeof draftId !== 'string' || draftId.length < 1 || draftId.length > STRING_LIMIT) { scrubToken(input); return Promise.reject(failure('request_error')); }
    const path = buildMessagePath(parsed.provider_mailbox_id, draftId, 'get');
    if (!path) { scrubToken(input); return Promise.reject(failure('request_error')); }
    const token = parsed.accessToken; parsed.accessToken = null; scrubToken(input);
    return issueGraphRequest({
      ...base(), method: 'GET', path, token, bodyText: null, prefer: PREFER_IMMUTABLE_ID, successStatuses: [200], notFoundIsUnknown: true,
      parseBody: (body) => {
        const id = extractDraftId(body); const isDraft = ownData(body, 'isDraft');
        if (id === null || id !== draftId || (isDraft !== true && isDraft !== false)) return null;
        if (isDraft === false) return Object.freeze({ outcome: 'sent', immutable_draft_id: id, isDraft: false, authorize_automatic_resend: false });
        return Object.freeze({ outcome: 'outcome_unknown', immutable_draft_id: id, isDraft: true, authorize_automatic_resend: false, authorize_automatic_create_reply: false });
      },
    });
  }
  return Object.freeze({ createReply, updateApprovedDraft, sendDraft, reconcileDraft, sendMail });
}
module.exports = Object.freeze({
  FAILURE_CODE, FAILURE_MESSAGE, PREFER_IMMUTABLE_ID, HOST, GRAPH_STAGES,
  EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_RUNTIME_WIRED, EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_PERSISTENCE_READY,
  EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_LOGGING_FORBIDDEN, EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_PINS_PREFER_IMMUTABLE_ID,
  EMAIL_MS_GRAPH_REPLY_DRAFT_TRANSPORT_DELIVERY_FROM_202, buildCreateReplyPath, buildMessagePath, buildSendMailPath,
  pickReplyDraftTransportMethods, REPLY_DRAFT_METHOD_KEYS, readTrustedGraphStage,
  createMicrosoftGraphReplyDraftTransport,
});
