'use strict';
/** Gate 3 Phase B PR B2b — token HTTP → Phase B scope → B1 custody/replacer. */
const util = require('util');
const transitionPolicy = require('./email-microsoft-reauthorization-transition-policy');
const {
  createMicrosoftPhaseBVerifiedGrantCustodyAdapter, CONFIG_KEYS: CUSTODY_CONFIG_KEYS,
  OUTCOME_UNKNOWN, SEALED_ACK,
} = require('./email-microsoft-phase-b-verified-grant-replacer');
const { createMicrosoftTokenHttpTransport, REQUEST_LIMIT_BYTES } = require('./email-microsoft-token-http-transport');
const { classifyAndNormalizePhaseBTokenResponseScope } = require('./email-microsoft-phase-b-token-response-scope');
const { validateEmailGrantEnvelopeProvider } = require('./email-grant-envelope-provider-contract');
const { resolveOptionalStageTelemetry, safeEmitStage } = require('./email-microsoft-oauth-stage-telemetry');
const { REDIRECT_URI, PHASE_B_SCOPES, asCanonGen } = require('./email-microsoft-phase-b-reauthorization-transaction-service');
const UT = util.types && typeof util.types === 'object' ? util.types : null;
const ISP = UT && typeof UT.isProxy === 'function' ? UT.isProxy : null;
const ERROR_CODE = 'MICROSOFT_PHASE_B_OAUTH_OPERATION_COMPOSITION_INVALID';
const ERROR_MESSAGE = 'Microsoft Phase B OAuth operation composition failed.';
const COMPLETION_METHOD = 'completeAuthorization';
const COMPLETION_ACK_STATUS = 'completed';
const COMPLETION_ACK = Object.freeze({ status: COMPLETION_ACK_STATUS });
const OUTCOME_UNKNOWN_ACK = Object.freeze({ status: OUTCOME_UNKNOWN });
const SUNSET_DEPLOYMENT = 'sunset-staging';
if (transitionPolicy.authorizationIntent() !== 'phase_b_reauthorization') throw new Error('phase_b_policy_contract_invalid');
const JSON_LIMIT = 65_536; const TOK_LIM = 8192; const ID_LIM = 32768; const MAX_EXP = 86_400; const SEC_LIM = 4096;
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']); const SCOPE_REJECTION_STAGES = Object.freeze(Object.fromEntries(['invalid', 'duplicate', 'dangerous', 'phase_a_mixed', 'unknown', 'missing_required'].map((category) => [category, `token_response_scope_rejected_${category}`])));
const CUSTODY_DEPS = Object.freeze(['verifiedIdentity', 'envelopeProvider', 'clock', 'replacer']);
const COMPLETION_KEYS = Object.freeze([
  'authorizationCode', 'transactionId', 'clientId', 'locationId', 'endpointId',
  'staffUserId', 'codeVerifier', 'nonce', 'applicationClientId', 'expectedPriorGrantGeneration',
]);
const DEPENDENCY_KEYS = Object.freeze([
  'verifiedIdentity', 'envelopeProvider', 'clock', 'replacer', 'transportDeps', 'secretProvider',
]);
const TRANSPORT_DEPS_KEYS = Object.freeze(['httpsImpl', 'timers']);
const TIMERS_KEYS = Object.freeze(['setTimeout', 'clearTimeout']);
const UUID_CANON = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const CODE_RE = /^[\x21-\x7e]{1,4096}$/;
const PRINT = /^[\x21-\x7e]+$/;
function failure() {
  const e = new Error(ERROR_MESSAGE);
  Object.defineProperty(e, 'name', { value: 'MicrosoftPhaseBOauthOperationCompositionError' });
  Object.defineProperty(e, 'code', { value: ERROR_CODE, enumerable: true }); return Object.freeze(e);
}
function isProxy(v) {
  try { if (typeof ISP !== 'function' || !UT) return true; return Reflect.apply(ISP, UT, [v]) === true; }
  catch { return true; }
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
function exactSvc(o, m) { return Boolean(exactFrozen(o, [m]) && typeof own(o, m) === 'function'); }
function ownFn(o, k) {
  try {
    if (o == null || isProxy(o) || (typeof o !== 'object' && typeof o !== 'function')) return null;
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || typeof d.value !== 'function') return null;
    return d.value;
  } catch { return null; }
}
function snapOrdered(input, keys) {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return null;
    const p = Object.getPrototypeOf(input);
    if (p !== Object.prototype && p !== null) return null;
    const a = Reflect.ownKeys(input);
    if (a.length !== keys.length) return null;
    for (let i = 0; i < keys.length; i += 1) if (a[i] !== keys[i]) return null;
    const out = Object.create(null);
    for (const k of keys) {
      const d = Object.getOwnPropertyDescriptor(input, k);
      if (!d || !Object.prototype.hasOwnProperty.call(d, 'value') || d.get || d.set || !d.enumerable) return null;
      out[k] = d.value;
    }
    return Object.freeze(out);
  } catch { return null; }
}
function printable(v, lim) { return typeof v === 'string' && v.length > 0 && v.length <= lim && PRINT.test(v); }
function snapCompletion(input) {
  try {
    if (!input || typeof input !== 'object' || isProxy(input) || Object.isFrozen(input) !== true) return null;
    const raw = snapOrdered(input, COMPLETION_KEYS); if (!raw) return null;
    if (typeof raw.authorizationCode !== 'string' || !CODE_RE.test(raw.authorizationCode)) return null;
    for (const k of ['transactionId', 'clientId', 'locationId', 'endpointId', 'staffUserId', 'applicationClientId']) {
      if (typeof raw[k] !== 'string' || !UUID_CANON.test(raw[k])) return null;
    }
    if (typeof raw.codeVerifier !== 'string' || !PKCE.test(raw.codeVerifier)
        || typeof raw.nonce !== 'string' || !NONCE_RE.test(raw.nonce)) return null;
    const prior = asCanonGen(raw.expectedPriorGrantGeneration); if (prior == null) return null;
    return Object.freeze({
      authorizationCode: raw.authorizationCode, transactionId: raw.transactionId, clientId: raw.clientId,
      locationId: raw.locationId, endpointId: raw.endpointId, staffUserId: raw.staffUserId,
      codeVerifier: raw.codeVerifier, nonce: raw.nonce, applicationClientId: raw.applicationClientId,
      expectedPriorGrantGeneration: prior,
    });
  } catch { return null; }
}
function snapTransport(raw) {
  try {
    if (!exactFrozen(raw, TRANSPORT_DEPS_KEYS) || isProxy(raw)) return null;
    const ordered = Reflect.ownKeys(raw);
    if (ordered.length !== TRANSPORT_DEPS_KEYS.length || ordered.some((k, i) => k !== TRANSPORT_DEPS_KEYS[i])) return null;
    const httpsImpl = own(raw, 'httpsImpl'); const timers = own(raw, 'timers');
    if (!httpsImpl || isProxy(httpsImpl) || (typeof httpsImpl !== 'object' && typeof httpsImpl !== 'function')) return null;
    const req = ownFn(httpsImpl, 'request'); if (typeof req !== 'function') return null;
    if (!timers || isProxy(timers) || typeof timers !== 'object' || Array.isArray(timers)) return null;
    let tp; try { tp = Object.getPrototypeOf(timers); } catch { return null; }
    if (tp !== Object.prototype && tp !== null) return null;
    const tk = Reflect.ownKeys(timers);
    if (tk.length !== TIMERS_KEYS.length || tk.some((k, i) => typeof k !== 'string' || k !== TIMERS_KEYS[i])) return null;
    const setT = ownFn(timers, 'setTimeout'); const clearT = ownFn(timers, 'clearTimeout');
    if (typeof setT !== 'function' || typeof clearT !== 'function') return null;
    return Object.freeze({
      httpsImpl: Object.freeze({ request(...a) { return Reflect.apply(req, httpsImpl, a); } }),
      timers: Object.freeze({ setTimeout(...a) { return Reflect.apply(setT, timers, a); }, clearTimeout(...a) { return Reflect.apply(clearT, timers, a); } }),
    });
  } catch { return null; }
}
function pinSecret(raw) {
  try {
    if (!raw || isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype || !exactPlain(raw, ['getClientSecret'])) return null;
    const fn = ownFn(raw, 'getClientSecret'); if (typeof fn !== 'function') return null;
    return Object.freeze({ getClientSecret(...a) { return Reflect.apply(fn, raw, a); } });
  } catch { return null; }
}
function assertUniqueKeys(body) {
  const seen = new Set(); let depth = 0, exp = false, inS = false, esc = false, ks = -1;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inS) { if (esc) { esc = false; continue; } if (ch === '\\') { esc = true; continue; } if (ch !== '"') continue; inS = false;
      if (ks >= 0) { let key; try { key = JSON.parse(body.slice(ks, i + 1)); } catch { throw failure(); } if (seen.has(key)) throw failure(); seen.add(key); ks = -1; exp = false; } continue; }
    if (ch === '"') { inS = true; if (depth === 1 && exp) ks = i; continue; }
    if (ch === '{' || ch === '[') { depth += 1; if (depth === 1 && ch === '{') exp = true; continue; }
    if (ch === '}' || ch === ']') { depth -= 1; continue; }
    if (depth === 1 && ch === ',') exp = true;
  }
}
function validateTokenResponse(response, stageTelemetry) {
  if (!response || isProxy(response) || Object.getPrototypeOf(response) !== Object.prototype || own(response, 'statusCode') !== 200) throw failure();
  const type = own(response, 'contentType'); const body = own(response, 'body');
  if (typeof type !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) throw failure();
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > JSON_LIMIT || body.includes('\ufffd')) throw failure(); safeEmitStage(stageTelemetry, 'token_response_envelope_validated');
  assertUniqueKeys(body);
  let value; try { value = JSON.parse(body); } catch { throw failure(); }
  if (!value || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).some((k) => typeof k !== 'string' || DANGEROUS.has(k))) throw failure(); safeEmitStage(stageTelemetry, 'token_response_json_validated');
  const tokenType = own(value, 'token_type'); const expiresIn = own(value, 'expires_in');
  const accessToken = own(value, 'access_token'); const refreshToken = own(value, 'refresh_token');
  const idToken = own(value, 'id_token'); const scope = own(value, 'scope');
  if (tokenType !== 'Bearer' || !Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_EXP
      || !printable(accessToken, TOK_LIM) || !printable(refreshToken, TOK_LIM) || !printable(idToken, ID_LIM)) throw failure();
  if (Object.prototype.hasOwnProperty.call(value, 'ext_expires_in')) {
    const ext = own(value, 'ext_expires_in'); if (!Number.isInteger(ext) || ext < 1 || ext > MAX_EXP) throw failure();
  } safeEmitStage(stageTelemetry, 'token_response_fields_validated');
  const scopeResult = classifyAndNormalizePhaseBTokenResponseScope(scope); const ns = scopeResult.value; if (ns === null) { safeEmitStage(stageTelemetry, SCOPE_REJECTION_STAGES[scopeResult.rejectionCategory]); throw failure(); }
  safeEmitStage(stageTelemetry, 'token_response_scope_validated'); return Object.freeze({ accessToken, refreshToken, tokenType, expiresIn, scope: ns, idToken });
}
function statusOne(v, st) {
  return Boolean(v && !isProxy(v) && Object.isFrozen(v) && Object.getPrototypeOf(v) === Object.prototype
    && Reflect.ownKeys(v).length === 1 && own(v, 'status') === st);
}
function pinDeps(dependencies) {
  if (!dependencies || isProxy(dependencies)) return null;
  const resolved = resolveOptionalStageTelemetry(dependencies, DEPENDENCY_KEYS);
  if (!resolved.ok || !resolved.stageTelemetry) return null;
  const ordered = Reflect.ownKeys(dependencies);
  const hasStage = ordered.includes('stageTelemetry');
  if (ordered.length !== (hasStage ? DEPENDENCY_KEYS.length + 1 : DEPENDENCY_KEYS.length)) return null;
  let coreIdx = 0;
  for (let i = 0; i < ordered.length; i += 1) {
    const key = ordered[i]; if (key === 'stageTelemetry') continue;
    if (coreIdx >= DEPENDENCY_KEYS.length || key !== DEPENDENCY_KEYS[coreIdx]) return null; coreIdx += 1;
  }
  if (coreIdx !== DEPENDENCY_KEYS.length) return null;
  const verifiedIdentity = own(dependencies, 'verifiedIdentity');
  const clock = own(dependencies, 'clock'); const replacer = own(dependencies, 'replacer');
  if (isProxy(verifiedIdentity) || isProxy(clock) || isProxy(replacer)) return null;
  if (!exactSvc(verifiedIdentity, 'verifyIdentity') || !exactSvc(clock, 'nowEpochSeconds')) return null;
  if (!replacer || typeof replacer !== 'object' || !Object.isFrozen(replacer)) return null;
  if (typeof own(replacer, 'replaceVerifiedGrant') !== 'function' || own(replacer, 'installVerifiedGrant') !== undefined) return null;
  const secretProvider = pinSecret(own(dependencies, 'secretProvider')); if (!secretProvider) return null;
  const providerOk = validateEmailGrantEnvelopeProvider(own(dependencies, 'envelopeProvider'));
  if (!providerOk.ok || !providerOk.value) return null;
  const transportDeps = snapTransport(own(dependencies, 'transportDeps')); if (!transportDeps) return null;
  return Object.freeze({ verifiedIdentity, envelopeProvider: providerOk.value, clock, replacer, transportDeps, secretProvider, stageTelemetry: resolved.stageTelemetry });
}
function buildCustodyConfig(snap) {
  const config = Object.freeze({
    clientId: snap.clientId, endpointId: snap.endpointId, operationId: snap.transactionId,
    actorStaffUserId: snap.staffUserId, expectedNonce: snap.nonce, expectedClientId: snap.applicationClientId,
    expectedPriorGrantGeneration: snap.expectedPriorGrantGeneration,
  });
  return (!exactFrozen(config, CUSTODY_CONFIG_KEYS) || 'locationId' in config || 'installVerifiedGrant' in config) ? null : config;
}
function createMicrosoftPhaseBOauthOperationComposition(dependencies) {
  let pinned;
  try { pinned = pinDeps(dependencies); if (!pinned) throw failure(); } catch { throw failure(); }
  let used = false;
  async function completeAuthorization(input) {
    if (used) throw failure(); used = true;
    try {
      const snap = snapCompletion(input); if (!snap) throw failure();
      const custodyConfig = buildCustodyConfig(snap); if (!custodyConfig) throw failure();
      const custodyDeps = Object.freeze({
        verifiedIdentity: pinned.verifiedIdentity, envelopeProvider: pinned.envelopeProvider,
        clock: pinned.clock, replacer: pinned.replacer, stageTelemetry: pinned.stageTelemetry,
      });
      if (!exactFrozen(custodyDeps, [...CUSTODY_DEPS, 'stageTelemetry'])) throw failure();
      let grantCustody; try { grantCustody = createMicrosoftPhaseBVerifiedGrantCustodyAdapter(custodyConfig, custodyDeps); } catch { throw failure(); }
      if (!exactSvc(grantCustody, 'acceptValidatedTokens')) throw failure();
      let transport; try { transport = createMicrosoftTokenHttpTransport(pinned.transportDeps); } catch { throw failure(); }
      if (!transport || typeof transport.postTokenForm !== 'function') throw failure();
      let clientSecret;
      try { clientSecret = await Reflect.apply(own(pinned.secretProvider, 'getClientSecret'), pinned.secretProvider, []); } catch { throw failure(); }
      if (!printable(clientSecret, SEC_LIM)) throw failure();
      const body = new URLSearchParams([
        ['client_id', snap.applicationClientId], ['client_secret', clientSecret],
        ['grant_type', 'authorization_code'], ['code', snap.authorizationCode],
        ['redirect_uri', REDIRECT_URI], ['code_verifier', snap.codeVerifier],
        ['scope', PHASE_B_SCOPES],
      ]).toString();
      if (Buffer.byteLength(body, 'utf8') > REQUEST_LIMIT_BYTES) throw failure();
      safeEmitStage(pinned.stageTelemetry, 'token_request_started');
      let rawResponse; try { rawResponse = await transport.postTokenForm(Object.freeze({ body })); } catch { throw failure(); }
      safeEmitStage(pinned.stageTelemetry, 'token_response_received');
      let selected; try { selected = validateTokenResponse(rawResponse, pinned.stageTelemetry); } catch { throw failure(); }
      safeEmitStage(pinned.stageTelemetry, 'token_response_validated');
      let sealed; try { sealed = await Reflect.apply(own(grantCustody, 'acceptValidatedTokens'), grantCustody, [selected]); } catch { throw failure(); }
      if (statusOne(sealed, OUTCOME_UNKNOWN)) return OUTCOME_UNKNOWN_ACK;
      if (!statusOne(sealed, 'accepted') && sealed !== SEALED_ACK) throw failure();
      return COMPLETION_ACK;
    } catch { throw failure(); }
  }
  return Object.freeze({ completeAuthorization });
}
module.exports = Object.freeze({
  ERROR_CODE, ERROR_MESSAGE, COMPLETION_METHOD, COMPLETION_ACK_STATUS, COMPLETION_ACK,
  OUTCOME_UNKNOWN, OUTCOME_UNKNOWN_ACK, COMPLETION_KEYS, DEPENDENCY_KEYS, TRANSPORT_DEPS_KEYS,
  TIMERS_KEYS, SUNSET_DEPLOYMENT, createMicrosoftPhaseBOauthOperationComposition,
});
