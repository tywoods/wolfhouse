'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4E/4G — source-only operator
 * prover for a future live Microsoft downscope + shared Phase B grant
 * continuity proof. Chapter 4G fills the immutable deployed-SHA allowlist
 * with the exact Sunset staging image and wires a fixed internal live-target
 * factory. Live compose/runProof are structurally disabled this chapter
 * (`LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER = false`). CLI defaults to
 * preparation and requires `--execute-once` plus typed confirmation. This
 * process does not execute live proof. Reuses canonical custody, refresh classification,
 * OIDC/JWKS, closed-data, and Chapter 4C claims/binding owners. Does not
 * clone JWT/SQL/Graph authority and does not create a Graph provider.
 *
 * Public surface is {attest, simulate, runProof} only. No callback,
 * getAccessToken, runClosed, raw token return, or generic HTTP. A fixed
 * internal consumer inspects signature-verified claims and returns a
 * descriptor-safe sanitized summary. CLI is the sole operator entry.
 *
 * @module email-luna-controlled-drafting-live-downscope-prover
 */

const crypto = require('node:crypto');
const {
  isProxySurface,
  ownData,
  exactOwnData,
  isCanonUuid,
  digestUtf8,
} = require('./email-luna-controlled-drafting-closed-data');
const {
  tryAcquireDelegatedGrantLease,
  openDelegatedGrantUnderLease,
  commitDelegatedGrantRotation,
  markDelegatedGrantReauthorizationRequired,
  markDelegatedGrantReconciliation,
  abortDelegatedGrantLease,
  getDelegatedGrantPublicStatus,
  resolveDelegatedReadAuthorityBinding,
} = require('./email-delegated-grant-custodian');
const {
  buildGrantEnvelopeAadV1,
  validateEmailGrantEnvelopeProvider,
  validateGrantEnvelopeRecordV1,
} = require('./email-grant-envelope-provider-contract');
const {
  createMicrosoftRefreshTokenRequestService,
  SUNSET_DEPLOYMENT: REQUEST_SUNSET,
  readTrustedMicrosoftRefreshTokenRequestStage,
  CONTROLLED_DRAFTING_SCOPE_VERSION,
  CONTROLLED_DRAFTING_REQUEST_SCOPE,
} = require('./email-microsoft-refresh-token-request');
const {
  EMAIL_MS_DELEGATED_SCOPE_VERSION,
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
} = require('./email-microsoft-delegated-oauth-contract');
const {
  createDelegatedGrantAccessSession,
  readTrustedDelegatedGrantAccessSessionInternalStage,
} = require('./email-delegated-grant-access-session');
const {
  createControlledDraftingAccessTokenClaimsInspector,
  createStaffSendPhaseBAccessTokenClaimsInspector,
  REQUIRED_SCP,
  STAFF_SEND_REQUIRED_SCP,
  OIDC_SCOPES_IN_SCP,
} = require('./email-luna-controlled-drafting-access-token-claims');
const {
  inspectEmailLunaControlledDraftingSession,
  EXPECTED_DATABASE,
} = require('./email-luna-controlled-drafting-session-proof');
const {
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  EXPECTED_LIVE_TARGET,
} = require('./email-luna-controlled-drafting-live-downscope-prover-live-target-constants');

const uncurryThis = (fn) => Function.prototype.call.bind(fn);
const objectFreeze = Object.freeze;
const objectCreate = Object.create;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const reflectOwnKeys = Reflect.ownKeys;
const arrayIsArray = Array.isArray;
const arrayIncludes = uncurryThis(Array.prototype.includes);
const stringTrim = uncurryThis(String.prototype.trim);
const stringToLowerCase = uncurryThis(String.prototype.toLowerCase);

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_DOWNSCOPE_PROVER_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting live downscope prover failed.';
const SUNSET_DEPLOYMENT = 'sunset-staging';
const SUNSET_TENANT = 'sunset';
const SUNSET_LOCATION_KEY = 'sunset-somo';
const LIVE_DEPLOY_SHA_ALLOWLIST = objectFreeze(['f6ee511273160cb46c72e345137800878d4c6512']);
const APPROVED_LIVE_REVISION = 'luna-sunset-staging-staff-api--ch4f-f6ee5112';
const APPROVED_LIVE_DIGEST = 'sha256:20d419d708a8e88115ccea3fb81bbd2a7d2ec67e0942c0be5be376d08d1a234a';
if (LIVE_DEPLOY_SHA_ALLOWLIST[0] !== EXPECTED_LIVE_TARGET.deployedSha) {
  throw new Error('controlled_drafting_live_target_sha_mismatch');
}
if (APPROVED_LIVE_REVISION !== EXPECTED_LIVE_TARGET.revision) {
  throw new Error('controlled_drafting_live_target_revision_mismatch');
}
if (APPROVED_LIVE_DIGEST !== EXPECTED_LIVE_TARGET.digest) {
  throw new Error('controlled_drafting_live_target_digest_mismatch');
}
if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== false) {
  throw new Error('controlled_drafting_live_execute_must_be_disabled_in_this_chapter');
}
const EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_DOWNSCOPE_PROVER_RUNTIME_WIRED = false;
const CONFIRM_WINDOW_MS = 15 * 60 * 1000;
const CONFIRM_FUTURE_SKEW_MS = 60 * 1000;
const OPERATOR_NONCE_RE = /^[0-9a-f]{64}$/;
const USED_OPERATOR_NONCES = new Set();
const LIVE_EXECUTE_CONSUMED = { value: false };
const ATTESTATION_KIND = 'configured_contract_only';
const SCOPE_PROFILE_ID = CONTROLLED_DRAFTING_SCOPE_VERSION;
const REQUESTED_SCOPE = CONTROLLED_DRAFTING_REQUEST_SCOPE;
const STAFF_SEND_SCOPE_PROFILE_ID = 'staff_send_phase_b_v1';
const WORKER_ID_DEFAULT = 'email-luna-controlled-drafting-live-downscope-prover';
const CONTINUITY_WORKER_ID = 'email-luna-controlled-drafting-live-downscope-continuity';
const CONFIRMATION_PHRASE = 'I_UNDERSTAND_SUNSET_STAGING_DOWNSCOPE_PROOF';
const EXPECTED_DOWNSCOPE_SCP = REQUIRED_SCP.join(' ');
const EXPECTED_STAFF_SEND_SCP = STAFF_SEND_REQUIRED_SCP.join(' ');

const COMMANDS = objectFreeze(['simulate', 'prove']);
const ALLOWED_TARGETS = objectFreeze(['fake', 'stock-pg', 'sunset-staging']);
const LIVE_ALIAS_TARGETS = objectFreeze(['live', 'azure', 'sunset-live']);
const EIGHT_FLAGS = objectFreeze([
  'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_ENABLED',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_COMPOSITION_ENABLED',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_PRODUCER_INTAKE_ENABLED',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_WORKER_TICK_ENABLED',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_PROVIDER_DRAFT_ENABLED',
  'LUNA_AUTO_SEND_ENABLED',
  'CUSTOMER_OUTREACH_WHATSAPP_ENABLED',
  'STAFF_AUTOMATED_NOTIFICATIONS_LIVE_ENABLED',
]);
const PRODUCTION_MARKERS = objectFreeze([
  'production', 'prod', 'luna_prod', 'wolfhouse_prod', 'sunset_prod', 'wolfhouse',
]);
const PROXY_ENV_KEYS = objectFreeze([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
]);
const DEPENDENCY_KEYS = objectFreeze([
  'deployment',
  'applicationClientId',
  'withPgClient',
  'envelopeProvider',
  'createSecretProvider',
  'transport',
  'createSignatureVerifier',
  'binding',
  'workerId',
  'login',
  'preflight',
]);
const BINDING_KEYS = objectFreeze([
  'clientId',
  'locationId',
  'endpointId',
  'mailboxId',
]);
const LOGIN_KEYS = objectFreeze(['producerClient', 'workerClient']);
const SERVICE_KEYS = objectFreeze(['attest', 'simulate', 'runProof']);
const FORBIDDEN_DEPENDENCY_KEYS = objectFreeze([
  'consumer', 'callback', 'runClosed', 'withToken', 'getAccessToken',
  'accessToken', 'fetch', 'request', 'client', 'graph', 'graphClient',
  'httpsImpl', 'timers', 'createReplyDraft', 'reconcileDraft', 'sendMail',
  'journal', 'journalStore',
]);
const ACCEPTED_GRANT_SCOPE_VERSIONS = objectFreeze([
  EMAIL_MS_DELEGATED_SCOPE_VERSION,
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
]);
const PROVER_STAGES = objectFreeze([
  'args', 'production', 'live_absent', 'flags', 'replica', 'counts',
  'confirmation', 'proxy', 'login', 'binding', 'status', 'lease', 'open',
  'grant_scope', 'secret', 'token', 'response', 'claims', 'dead_grant',
  'reseal', 'commit', 'release', 'uncertainty_persistence', 'continuity',
  'readback',
]);
const STAGE_SET = new Set(PROVER_STAGES);
const PROVER_FAILURE_NOTE_KEYS = objectFreeze(['stage', 'code']);
const PROVER_FAILURE_BRAND = new WeakMap();
const DETAIL_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ROTATING_RESPONSE_UNCERTAINTY_DETAILS = objectFreeze({
  binding: 'post_ms_binding',
  claims: 'post_ms_claims',
  reseal: 'post_ms_pre_seal',
  commit: 'post_ms_cas_conflict',
  token: 'ms_refresh_transport',
  response: 'ms_refresh_uncertain',
  uncertainty_persistence: 'persistence_unproven',
});
const CLAIMS_SUMMARY_KEYS = objectFreeze([
  'ok', 'scope_profile_id', 'scp', 'mail_send', 'mail_readwrite', 'app_only',
  'kid', 'alg', 'iss_matches', 'aud_matches', 'oid_matches', 'tid_matches',
  'ver_matches', 'exp_window_ok', 'token_lifetime_seconds',
]);
const IDENTITY_SQL = [
  'SELECT',
  '  session_user::text IS NOT DISTINCT FROM current_user::text AS session_matches_current,',
  "  current_database()::text AS current_database,",
  "  current_setting('ssl', true) AS ssl,",
  "  encode(sha256(convert_to(session_user::text, 'UTF8')), 'hex') AS session_fingerprint,",
  "  encode(sha256(convert_to(current_user::text, 'UTF8')), 'hex') AS current_fingerprint",
].join('\n');
const IDENTITY_KEYS = objectFreeze([
  'session_matches_current', 'current_database', 'ssl',
  'session_fingerprint', 'current_fingerprint',
]);

if (REQUEST_SUNSET !== SUNSET_DEPLOYMENT) {
  throw new Error('controlled_drafting_live_downscope_prover_sunset_deployment_mismatch');
}

function failure() {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  objectFreeze(error);
  return error;
}

function exactPlainData(object, keys) {
  if (!object || objectGetPrototypeOf(object) !== Object.prototype || isProxySurface(object)) {
    return false;
  }
  const actual = reflectOwnKeys(object);
  if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !arrayIncludes(keys, key))) {
    return false;
  }
  return keys.every((key) => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return descriptor && !descriptor.get && !descriptor.set && objectHasOwn(descriptor, 'value');
    } catch (_) {
      return false;
    }
  });
}

function exactSealedTransport(object) {
  return object
    && Object.isFrozen(object)
    && objectGetPrototypeOf(object) === Object.prototype
    && exactPlainData(object, ['postTokenForm'])
    && typeof ownData(object, 'postTokenForm') === 'function';
}

function parseWorkerId(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v.length < 1 || v.length > 128 || /\s/.test(v) || v !== raw) return null;
  return v;
}

function snapshotBinding(raw) {
  if (!exactPlainData(raw, BINDING_KEYS)) return null;
  const clientId = ownData(raw, 'clientId');
  const locationId = ownData(raw, 'locationId');
  const endpointId = ownData(raw, 'endpointId');
  const mailboxId = ownData(raw, 'mailboxId');
  if (!isCanonUuid(clientId) || !isCanonUuid(locationId) || !isCanonUuid(endpointId)) return null;
  if (!isCanonUuid(mailboxId)) return null;
  return objectFreeze({
    clientId: stringTrim(clientId),
    locationId: stringTrim(locationId),
    endpointId: stringTrim(endpointId),
    mailboxId: stringTrim(mailboxId),
  });
}

function freezeStageNote(stage, code) {
  try {
    if (typeof stage !== 'string' || !STAGE_SET.has(stage)) return null;
    const resolved = typeof code === 'string' && DETAIL_CODE_RE.test(code) ? code : stage;
    const note = { stage, code: resolved };
    if (!exactPlainData(note, PROVER_FAILURE_NOTE_KEYS)) return null;
    return objectFreeze(note);
  } catch (_) {
    return null;
  }
}

function brandProverFailure(target, stage, code) {
  try {
    if (target == null || (typeof target !== 'object' && typeof target !== 'function')) return target;
    const note = freezeStageNote(stage, code);
    if (!note) return target;
    PROVER_FAILURE_BRAND.set(target, note);
    return target;
  } catch (_) {
    return target;
  }
}

function readTrustedLiveDownscopeProverFailure(target) {
  try {
    if (target == null || (typeof target !== 'object' && typeof target !== 'function')) return null;
    const stored = PROVER_FAILURE_BRAND.get(target);
    if (!stored) return null;
    if (stored && typeof stored === 'object') return freezeStageNote(stored.stage, stored.code);
    return null;
  } catch (_) {
    return null;
  }
}

function output(pairs) {
  const obj = objectCreate(null);
  for (let i = 0; i < pairs.length; i += 1) {
    obj[pairs[i][0]] = pairs[i][1];
  }
  return objectFreeze(obj);
}

function sha40(value) {
  return typeof value === 'string' && value.length === 40 && /^[0-9a-f]{40}$/.test(value);
}

function liveModeAllowed(sha) {
  if (!sha40(sha)) return false;
  if (LIVE_DEPLOY_SHA_ALLOWLIST.length !== 1) return false;
  return sha === LIVE_DEPLOY_SHA_ALLOWLIST[0];
}

function refusedProduction(env) {
  const deployment = ownData(env, 'LUNA_DEPLOYMENT');
  const tenant = ownData(env, 'DEFAULT_CLIENT_SLUG');
  if (typeof deployment === 'string' && arrayIncludes(PRODUCTION_MARKERS, stringToLowerCase(deployment))) {
    return true;
  }
  if (typeof tenant === 'string' && arrayIncludes(PRODUCTION_MARKERS, stringToLowerCase(tenant))) {
    return true;
  }
  return false;
}

function proxyPresent(env) {
  if (!env || typeof env !== 'object' || isProxySurface(env)) return true;
  for (let i = 0; i < PROXY_ENV_KEYS.length; i += 1) {
    const value = ownData(env, PROXY_ENV_KEYS[i]);
    if (typeof value === 'string' && value.length > 0) return true;
  }
  return false;
}

function flagsAllFalse(env) {
  for (let i = 0; i < EIGHT_FLAGS.length; i += 1) {
    const raw = ownData(env, EIGHT_FLAGS[i]);
    if (raw === true) return false;
    if (typeof raw === 'string') {
      const v = stringToLowerCase(stringTrim(raw));
      if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return false;
    }
  }
  return true;
}

function flagsAllLiteralFalse(env) {
  for (let i = 0; i < EIGHT_FLAGS.length; i += 1) {
    const raw = ownData(env, EIGHT_FLAGS[i]);
    if (raw !== false && raw !== 'false') return false;
  }
  return true;
}

function loadLiveTargetOwner() {
  if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== true) {
    throw new Error('controlled_drafting_live_target_owner_disabled_in_this_chapter');
  }
  return require('./email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target');
}

function invokedFromSourceTestHarness() {
  try {
    const main = require.main && require.main.filename;
    if (typeof main !== 'string') return false;
    const base = main.replace(/\\/g, '/').split('/').pop();
    return /^(verify|prove)-email-luna-controlled-drafting-live-downscope-prover/.test(base);
  } catch (_) {
    return true;
  }
}

function validOperatorNonce(value) {
  return typeof value === 'string' && OPERATOR_NONCE_RE.test(value);
}

function validConfirmIssuedAt(value, nowMs) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 40) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (ms > now + CONFIRM_FUTURE_SKEW_MS) return false;
  if (now - ms > CONFIRM_WINDOW_MS) return false;
  return true;
}

function isLiveAliasTarget(target) {
  return arrayIncludes(LIVE_ALIAS_TARGETS, target);
}

function replicaIsOne(env, preflight) {
  const fromPre = ownData(preflight, 'replica');
  if (fromPre !== undefined && fromPre !== null) return fromPre === 1 || fromPre === '1';
  const raw = ownData(env, 'EMAIL_LUNA_CONTROLLED_DRAFTING_RUNTIME_REPLICA_COUNT');
  return raw === 1 || raw === '1';
}

function parseArgs(argv) {
  const args = arrayIsArray(argv) ? argv.slice() : [];
  const seen = objectCreate(null);
  const flags = objectCreate(null);
  flags.target = 'fake';
  flags.command = 'simulate';
  flags.confirm = null;
  flags.deploySha = null;
  flags.sourceSha = null;
  flags.revision = null;
  flags.digest = null;
  flags.operatorNonce = null;
  flags.confirmIssuedAt = null;
  flags.executeOnce = false;
  flags.invalid = false;
  flags.invalidReason = null;
  function markSeen(name) {
    if (seen[name] === true) {
      flags.invalid = true;
      flags.invalidReason = 'duplicate_arg';
      return false;
    }
    seen[name] = true;
    return true;
  }
  function takeValue(name, i) {
    const value = args[i + 1];
    if (typeof value !== 'string' || value.length < 1 || value.startsWith('--')) {
      flags.invalid = true;
      flags.invalidReason = 'missing_arg_value';
      return i;
    }
    if (!markSeen(name)) return i + 1;
    flags[name] = value;
    return i + 1;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--target') {
      i = takeValue('target', i);
    } else if (arg === '--confirm') {
      i = takeValue('confirm', i);
    } else if (arg === '--deploy-sha') {
      i = takeValue('deploySha', i);
    } else if (arg === '--source-sha') {
      i = takeValue('sourceSha', i);
    } else if (arg === '--revision') {
      i = takeValue('revision', i);
    } else if (arg === '--digest') {
      i = takeValue('digest', i);
    } else if (arg === '--operator-nonce') {
      i = takeValue('operatorNonce', i);
    } else if (arg === '--confirm-issued-at') {
      i = takeValue('confirmIssuedAt', i);
    } else if (arg === '--execute-once') {
      if (!markSeen('executeOnce')) continue;
      flags.executeOnce = true;
    } else if (arg && !arg.startsWith('--') && arrayIncludes(COMMANDS, arg)) {
      if (!markSeen('command')) continue;
      flags.command = arg;
    } else {
      flags.invalid = true;
      flags.invalidReason = 'unknown_or_hostile_arg';
    }
  }
  return objectFreeze({
    target: flags.target,
    command: flags.command,
    confirm: flags.confirm,
    deploySha: flags.deploySha,
    sourceSha: flags.sourceSha,
    revision: flags.revision,
    digest: flags.digest,
    operatorNonce: flags.operatorNonce,
    confirmIssuedAt: flags.confirmIssuedAt,
    executeOnce: flags.executeOnce === true,
    invalid: flags.invalid === true,
    invalidReason: flags.invalidReason,
  });
}

function attestSuccess() {
  return objectFreeze({
    ok: true,
    attestation_kind: ATTESTATION_KIND,
    scope_profile_id: SCOPE_PROFILE_ID,
    requested_scopes: REQUESTED_SCOPE,
    expected_downscope_scp: EXPECTED_DOWNSCOPE_SCP,
    expected_staff_send_scp: EXPECTED_STAFF_SEND_SCP,
    oidc_scopes_in_scp: false,
    send_capable: false,
    mail_send: false,
    live_mode_structurally_absent: false,
    live_execution_gated: true,
    live_execution_authorized_in_this_chapter: false,
    approved_deploy_sha: LIVE_DEPLOY_SHA_ALLOWLIST[0],
    allowlist_size: LIVE_DEPLOY_SHA_ALLOWLIST.length,
    graph_provider: false,
    runtime_wired: EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_DOWNSCOPE_PROVER_RUNTIME_WIRED,
  });
}

function simulationRecord(parsed, reason, extra) {
  const preparation = extra && extra.preparation === true;
  const pairs = [
    ['ok', parsed && parsed.invalid !== true && !reason],
    ['command', parsed && parsed.command ? parsed.command : 'simulate'],
    ['target', parsed && parsed.target ? parsed.target : 'fake'],
    ['simulation', true],
    ['preparation', preparation],
    ['execute_once', parsed && parsed.executeOnce === true],
    ['live_evidence', false],
    ['offline_fake_proof', false],
    ['token_returned', false],
    ['graph_called', false],
    ['send_called', false],
    ['journal_called', false],
    ['mutated_098', false],
    ['token_verified', false],
    ['jwks_live', false],
    ['microsoft_live', false],
    ['login_proven', false],
    ['custody_proven', false],
    ['reason', reason || (parsed && parsed.invalidReason) || null],
    ['allowlist_size', LIVE_DEPLOY_SHA_ALLOWLIST.length],
    ['live_mode_structurally_absent', false],
    ['live_execution_gated', true],
    ['live_execution_authorized_in_this_chapter', false],
    ['approved_deploy_sha', LIVE_DEPLOY_SHA_ALLOWLIST[0]],
    ['live_proof_executed', false],
  ];
  if (extra && extra.deploy_sha) pairs.push(['deploy_sha', extra.deploy_sha]);
  if (extra && extra.revision) pairs.push(['revision', extra.revision]);
  if (extra && extra.digest) pairs.push(['digest', extra.digest]);
  return output(pairs);
}

function acceptedGrantScope(version) {
  return version === EMAIL_MS_DELEGATED_SCOPE_VERSION
    || version === EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION;
}

function valueContainsSecret(value, token) {
  if (typeof token !== 'string' || token.length < 1) return false;
  try {
    if (typeof value === 'string') return value.includes(token);
    if (value && (typeof value === 'object' || typeof value === 'function')) {
      return JSON.stringify(value).includes(token);
    }
  } catch (_) {
    return true;
  }
  return false;
}

function copyClaimsSummary(raw) {
  if (!raw || typeof raw !== 'object' || isProxySurface(raw) || arrayIsArray(raw)) return null;
  const out = objectCreate(null);
  for (let i = 0; i < CLAIMS_SUMMARY_KEYS.length; i += 1) {
    const key = CLAIMS_SUMMARY_KEYS[i];
    out[key] = ownData(raw, key);
  }
  if (out.ok !== true) return null;
  if (typeof out.scp !== 'string') return null;
  return objectFreeze(out);
}

function resolveQuery(client) {
  if (!client || (typeof client !== 'object' && typeof client !== 'function') || isProxySurface(client)) {
    return null;
  }
  try {
    const own = Object.getOwnPropertyDescriptor(client, 'query');
    if (own) {
      return objectHasOwn(own, 'value') && typeof own.value === 'function' && !own.get && !own.set
        ? own.value
        : null;
    }
    let proto = objectGetPrototypeOf(client);
    let depth = 0;
    while (proto && proto !== Object.prototype && depth < 8) {
      if (isProxySurface(proto)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'query');
      if (descriptor) {
        return objectHasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
          && !descriptor.get && !descriptor.set
          ? descriptor.value
          : null;
      }
      proto = objectGetPrototypeOf(proto);
      depth += 1;
    }
  } catch (_) {
    return null;
  }
  return null;
}

async function readIdentity(client) {
  const queryFn = resolveQuery(client);
  if (typeof queryFn !== 'function' || isProxySurface(queryFn)) return null;
  let result;
  try {
    result = await queryFn.call(client, IDENTITY_SQL);
  } catch (_) {
    return null;
  }
  if (!result || typeof result !== 'object' || isProxySurface(result) || arrayIsArray(result)) {
    return null;
  }
  const rows = ownData(result, 'rows');
  if (!arrayIsArray(rows) || rows.length !== 1 || isProxySurface(rows)) return null;
  const row = ownData(rows, 0);
  const parsed = exactOwnData(row, IDENTITY_KEYS);
  if (!parsed) return null;
  if (typeof parsed.session_fingerprint !== 'string'
      || !/^[0-9a-f]{64}$/.test(parsed.session_fingerprint)) {
    return null;
  }
  if (typeof parsed.current_fingerprint !== 'string'
      || !/^[0-9a-f]{64}$/.test(parsed.current_fingerprint)) {
    return null;
  }
  return objectFreeze({
    session_matches_current: parsed.session_matches_current === true,
    current_database: parsed.current_database,
    ssl: parsed.ssl,
    session_fingerprint: parsed.session_fingerprint,
    current_fingerprint: parsed.current_fingerprint,
    tls_ok: parsed.ssl === 'on' || parsed.ssl === true,
    db_ok: parsed.current_database === EXPECTED_DATABASE,
  });
}

async function proveDirectLogins(login, binding, target) {
  if (!login || !exactPlainData(login, LOGIN_KEYS)) return { ok: false, reason: 'login_missing' };
  const producerClient = ownData(login, 'producerClient');
  const workerClient = ownData(login, 'workerClient');
  if (!producerClient || !workerClient || producerClient === workerClient) {
    return { ok: false, reason: 'login_not_distinct' };
  }
  const sessionBinding = objectFreeze({
    client_id: binding.clientId,
    location_id: binding.locationId,
    location_key: SUNSET_LOCATION_KEY,
  });
  let producerSession;
  let workerSession;
  try {
    producerSession = await inspectEmailLunaControlledDraftingSession(
      producerClient, sessionBinding, 'producer',
    );
    workerSession = await inspectEmailLunaControlledDraftingSession(
      workerClient, sessionBinding, 'worker',
    );
  } catch (_) {
    return { ok: false, reason: 'login_inspect_failed' };
  }
  if (!producerSession || producerSession.ok !== true || producerSession.login_ok !== true
      || producerSession.mapping_ok !== true || producerSession.execute_ok !== true) {
    return { ok: false, reason: 'producer_login_unproven' };
  }
  if (!workerSession || workerSession.ok !== true || workerSession.login_ok !== true
      || workerSession.mapping_ok !== true || workerSession.execute_ok !== true) {
    return { ok: false, reason: 'worker_login_unproven' };
  }
  const producerId = await readIdentity(producerClient);
  const workerId = await readIdentity(workerClient);
  if (!producerId || !workerId) return { ok: false, reason: 'login_identity_unproven' };
  if (producerId.session_matches_current !== true || workerId.session_matches_current !== true) {
    return { ok: false, reason: 'set_role_or_owner_refused' };
  }
  if (producerId.session_fingerprint === workerId.session_fingerprint) {
    return { ok: false, reason: 'login_not_distinct' };
  }
  if (producerId.db_ok !== true || workerId.db_ok !== true) {
    return { ok: false, reason: 'database_unproven' };
  }
  const tlsRequired = target === 'sunset-staging';
  if (tlsRequired && (producerId.tls_ok !== true || workerId.tls_ok !== true)) {
    return { ok: false, reason: 'tls_unproven' };
  }
  return objectFreeze({
    ok: true,
    producer_login_ok: true,
    worker_login_ok: true,
    logins_distinct: true,
    tls_ok: producerId.tls_ok === true && workerId.tls_ok === true,
    db_ok: true,
    producer_session_fingerprint: producerId.session_fingerprint,
    worker_session_fingerprint: workerId.session_fingerprint,
  });
}

async function inspectClosedClaims(createInspector, createSignatureVerifier, token, expected) {
  if (typeof token !== 'string' || !token) throw failure();
  const verifier = createSignatureVerifier();
  if (!verifier || typeof ownData(verifier, 'verify') !== 'function') throw failure();
  const inspector = createInspector(objectFreeze({ signatureVerifier: verifier }));
  let summary;
  try {
    summary = await inspector.inspect(objectFreeze({
      accessToken: token,
      expectedTenantId: expected.expectedTenantId,
      expectedClientId: expected.expectedClientId,
      expectedPrincipalOid: expected.expectedPrincipalOid,
      nowEpochSeconds: Math.floor(Date.now() / 1000),
    }));
  } catch (err) {
    if (valueContainsSecret(err, token)) throw failure();
    throw err;
  }
  const closed = copyClaimsSummary(summary);
  if (!closed || valueContainsSecret(closed, token) || valueContainsSecret(summary, token)) {
    throw failure();
  }
  return closed;
}

function createEmailLunaControlledDraftingLiveDownscopeProver(deps) {
  let withPgClient;
  let envelopeProvider;
  let applicationClientId;
  let createSecretProvider;
  let transport;
  let createSignatureVerifier;
  let binding;
  let workerId;
  let login;
  let preflight;
  try {
    if (deps && typeof deps === 'object') {
      const depKeys = reflectOwnKeys(deps);
      for (let i = 0; i < depKeys.length; i += 1) {
        if (arrayIncludes(FORBIDDEN_DEPENDENCY_KEYS, depKeys[i])) throw failure();
      }
    }
    if (!exactPlainData(deps, DEPENDENCY_KEYS)
        || ownData(deps, 'deployment') !== SUNSET_DEPLOYMENT) {
      throw failure();
    }
    applicationClientId = ownData(deps, 'applicationClientId');
    withPgClient = ownData(deps, 'withPgClient');
    envelopeProvider = ownData(deps, 'envelopeProvider');
    createSecretProvider = ownData(deps, 'createSecretProvider');
    transport = ownData(deps, 'transport');
    createSignatureVerifier = ownData(deps, 'createSignatureVerifier');
    binding = snapshotBinding(ownData(deps, 'binding'));
    workerId = parseWorkerId(ownData(deps, 'workerId') || WORKER_ID_DEFAULT);
    login = ownData(deps, 'login');
    preflight = ownData(deps, 'preflight') || {};
    if (typeof applicationClientId !== 'string' || !isCanonUuid(applicationClientId)) throw failure();
    if (!workerId) throw failure();
    if (typeof withPgClient !== 'function' || isProxySurface(withPgClient)) throw failure();
    if (typeof createSecretProvider !== 'function' || isProxySurface(createSecretProvider)) throw failure();
    if (typeof createSignatureVerifier !== 'function' || isProxySurface(createSignatureVerifier)) {
      throw failure();
    }
    if (!binding) throw failure();
    const prov = validateEmailGrantEnvelopeProvider(envelopeProvider);
    if (!prov.ok) throw failure();
    envelopeProvider = prov.value;
    if (!exactSealedTransport(transport)) throw failure();
    if (!login || !exactPlainData(login, LOGIN_KEYS)) throw failure();
  } catch (_) {
    throw failure();
  }

  let used = false;

  function failAt(stage, code) {
    const error = failure();
    brandProverFailure(error, stage, code);
    return error;
  }

  function attest() {
    return attestSuccess();
  }

  function simulate(input) {
    const parsed = input && input.parsed ? input.parsed : parseArgs(input && input.argv);
    const env = (input && input.env) || {};
    if (parsed.invalid === true) return simulationRecord(parsed);
    if (refusedProduction(env)) {
      return simulationRecord(parsed, 'production_or_wolfhouse_refused');
    }
    if (proxyPresent(env)) return simulationRecord(parsed, 'proxy_refused');
    if (isLiveAliasTarget(parsed.target)) {
      return simulationRecord(parsed, 'target_live_alias_refused');
    }
    if (parsed.target === 'sunset-staging') {
      return simulationRecord(parsed, null, {
        preparation: true,
        deploy_sha: liveModeAllowed(parsed.deploySha) ? parsed.deploySha : null,
      });
    }
    if (parsed.target !== 'fake' && parsed.target !== 'stock-pg') {
      return simulationRecord(parsed, 'target_not_fake_or_stock_pg');
    }
    return simulationRecord(parsed, null);
  }

  async function runDownscope(client, ids) {
    let lease = null;
    let openedOwner = null;
    let refreshToken = null;
    let accessCandidate = null;
    let accessTokenOwner = null;
    let refreshToSeal = null;
    let classified = null;
    let selectedOwner = null;
    let sealedOwner = null;
    let refreshTokenOmitted = false;
    let receivedRotatingRefresh = false;
    let suppressLeaseAbort = false;
    let claimsSummary = null;
    let generationAfter = null;

    function dropTokenRefs() {
      accessCandidate = null;
      accessTokenOwner = null;
      refreshToken = null;
      refreshToSeal = null;
      classified = null;
      selectedOwner = null;
      sealedOwner = null;
      openedOwner = null;
    }

    async function safeAbort(held) {
      if (!held) return;
      try {
        await abortDelegatedGrantLease({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: held.lease_token,
          expectedGeneration: held.grant_generation,
        }, { client });
      } catch (_) { /* sanitized */ }
    }

    async function refuseAfterRotatingMicrosoftResponse(stage, detailCode) {
      const held = lease;
      lease = null;
      suppressLeaseAbort = true;
      dropTokenRefs();
      const detail = typeof detailCode === 'string' && DETAIL_CODE_RE.test(detailCode)
        ? detailCode
        : (ROTATING_RESPONSE_UNCERTAINTY_DETAILS[stage] || 'post_ms_pre_commit');
      if (!held) throw failAt(stage);
      let marked;
      try {
        marked = await markDelegatedGrantReconciliation({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: held.lease_token,
          expectedGeneration: held.grant_generation,
          reconcileState: 'ms_response_uncertain',
          reconcileDetailCode: detail,
        }, { client });
      } catch (_) {
        throw failAt('uncertainty_persistence', 'persistence_unproven');
      }
      if (!marked || marked.ok !== true) {
        throw failAt('uncertainty_persistence', 'persistence_unproven');
      }
      let aborted;
      try {
        aborted = await abortDelegatedGrantLease({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: held.lease_token,
          expectedGeneration: held.grant_generation,
        }, { client });
      } catch (_) {
        throw failAt(stage);
      }
      if (aborted && aborted.ok === true) {
        const dto = aborted.value;
        if (!dto || dto.reconcile_state !== 'ms_response_uncertain') {
          throw failAt('uncertainty_persistence', 'persistence_unproven');
        }
      }
      throw failAt(stage);
    }

    async function refuseBeforeCommit(stage, detailCode) {
      if (receivedRotatingRefresh === true) {
        await refuseAfterRotatingMicrosoftResponse(stage, detailCode);
      }
      dropTokenRefs();
      await safeAbort(lease);
      lease = null;
      throw failAt(stage);
    }

    try {
      const acquired = await tryAcquireDelegatedGrantLease({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
        workerId,
      }, { client });
      if (!acquired.ok) throw failAt('lease');
      lease = acquired.value;
      if (!acceptedGrantScope(lease.scope_version)) {
        await safeAbort(lease);
        lease = null;
        throw failAt('grant_scope');
      }

      openedOwner = await openDelegatedGrantUnderLease(lease, { client, envelopeProvider });
      if (!openedOwner.ok
          || !openedOwner.value
          || typeof openedOwner.value.refresh_token !== 'string') {
        await safeAbort(lease);
        lease = null;
        throw failAt('open');
      }
      refreshToken = openedOwner.value.refresh_token;
      openedOwner = null;

      const secretProvider = createSecretProvider();
      if (!secretProvider
          || objectGetPrototypeOf(secretProvider) !== Object.prototype
          || typeof ownData(secretProvider, 'getClientSecret') !== 'function') {
        await safeAbort(lease);
        lease = null;
        throw failAt('secret');
      }

      const exchange = createMicrosoftRefreshTokenRequestService(objectFreeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId,
        secretProvider,
        transport,
      }));
      try {
        classified = await exchange.exchangeRefreshToken(objectFreeze({
          refreshToken,
          scopeVersion: SCOPE_PROFILE_ID,
        }));
      } catch (exchangeErr) {
        const refreshNote = readTrustedMicrosoftRefreshTokenRequestStage(exchangeErr);
        const exchangeStage = refreshNote && refreshNote.stage ? refreshNote.stage : 'token';
        if (exchangeStage === 'secret') {
          dropTokenRefs();
          await safeAbort(lease);
          lease = null;
          throw failAt('secret');
        }
        if (exchangeStage === 'response') {
          await refuseAfterRotatingMicrosoftResponse('response', 'ms_refresh_uncertain');
        }
        await refuseAfterRotatingMicrosoftResponse('token', 'ms_refresh_transport');
      }

      if (classified.kind === 'invalid_grant') {
        dropTokenRefs();
        const held = lease;
        suppressLeaseAbort = true;
        lease = null;
        if (!held) throw failAt('dead_grant');
        let reauth;
        try {
          reauth = await markDelegatedGrantReauthorizationRequired({
            clientId: ids.clientId,
            endpointId: ids.endpointId,
            leaseToken: held.lease_token,
            expectedGeneration: held.grant_generation,
            reason: 'invalid_grant',
          }, { client });
        } catch (_) {
          throw failAt('uncertainty_persistence', 'persistence_unproven');
        }
        if (!reauth || reauth.ok !== true) {
          throw failAt('uncertainty_persistence', 'persistence_unproven');
        }
        throw failAt('dead_grant');
      }

      if (classified.kind !== 'success' || !classified.selected) {
        classified = null;
        await refuseAfterRotatingMicrosoftResponse('response', 'ms_refresh_uncertain');
      }

      try {
        selectedOwner = classified.selected;
        classified = null;
        if (selectedOwner
            && typeof selectedOwner.accessToken === 'string'
            && selectedOwner.accessToken) {
          accessCandidate = selectedOwner.accessToken;
        }
        if (typeof accessCandidate !== 'string' || !accessCandidate) {
          accessCandidate = null;
          await refuseAfterRotatingMicrosoftResponse('response', 'ms_refresh_uncertain');
        }
        accessTokenOwner = accessCandidate;
        accessCandidate = null;

        if (selectedOwner.refreshTokenOmitted === true) {
          if (typeof refreshToken !== 'string' || !refreshToken) {
            accessTokenOwner = null;
            await refuseAfterRotatingMicrosoftResponse('response', 'ms_refresh_uncertain');
          }
          refreshTokenOmitted = true;
          receivedRotatingRefresh = false;
          refreshToSeal = null;
        } else if (selectedOwner.refreshTokenOmitted === false
            && typeof selectedOwner.refreshToken === 'string'
            && selectedOwner.refreshToken) {
          refreshTokenOmitted = false;
          receivedRotatingRefresh = true;
          refreshToSeal = selectedOwner.refreshToken;
        } else {
          accessTokenOwner = null;
          await refuseAfterRotatingMicrosoftResponse('response', 'ms_refresh_uncertain');
        }
      } finally {
        classified = null;
        selectedOwner = null;
        accessCandidate = null;
      }
      refreshToken = null;

      const bound = await resolveDelegatedReadAuthorityBinding({
        clientId: binding.clientId,
        locationId: binding.locationId,
        endpointId: binding.endpointId,
      }, { client });
      if (!bound.ok
          || !bound.value
          || bound.value.provider !== 'microsoft_graph'
          || bound.value.providerMailboxId !== binding.mailboxId
          || typeof bound.value.providerTenantId !== 'string'
          || !isCanonUuid(bound.value.providerTenantId)
          || typeof bound.value.providerPrincipalOid !== 'string'
          || !isCanonUuid(bound.value.providerPrincipalOid)
          || bound.value.bindingStatus !== 'verified') {
        await refuseBeforeCommit('binding', ROTATING_RESPONSE_UNCERTAINTY_DETAILS.binding);
      }

      try {
        claimsSummary = await inspectClosedClaims(
          createControlledDraftingAccessTokenClaimsInspector,
          createSignatureVerifier,
          accessTokenOwner,
          {
            expectedTenantId: bound.value.providerTenantId,
            expectedClientId: applicationClientId,
            expectedPrincipalOid: bound.value.providerPrincipalOid,
          },
        );
      } catch (_) {
        await refuseBeforeCommit('claims', ROTATING_RESPONSE_UNCERTAINTY_DETAILS.claims);
      }
      if (!claimsSummary
          || claimsSummary.mail_send !== false
          || claimsSummary.scp !== EXPECTED_DOWNSCOPE_SCP
          || claimsSummary.app_only !== false) {
        await refuseBeforeCommit('claims', ROTATING_RESPONSE_UNCERTAINTY_DETAILS.claims);
      }

      accessTokenOwner = null;

      if (refreshTokenOmitted === true) {
        const released = await abortDelegatedGrantLease({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: lease.lease_token,
          expectedGeneration: lease.grant_generation,
        }, { client });
        if (!released.ok) throw failAt('release');
        generationAfter = lease.grant_generation;
        lease = null;
        refreshToSeal = null;
      } else {
        const nextOperationId = crypto.randomUUID();
        const nextGeneration = lease.grant_generation + 1;
        let aad;
        try {
          aad = buildGrantEnvelopeAadV1({
            clientId: ids.clientId,
            endpointId: ids.endpointId,
            grantGeneration: nextGeneration,
            operationId: nextOperationId,
          });
        } catch (_) {
          await refuseBeforeCommit('reseal', 'post_ms_pre_seal');
        }
        try {
          sealedOwner = await envelopeProvider.sealGrantPayload({
            refresh_token: refreshToSeal,
            aad,
            operation_id: nextOperationId,
          });
        } catch (_) {
          await refuseBeforeCommit('reseal', 'post_ms_pre_seal');
        } finally {
          refreshToSeal = null;
        }
        const envCheck = validateGrantEnvelopeRecordV1(sealedOwner);
        sealedOwner = null;
        if (!envCheck.ok) {
          await refuseBeforeCommit('reseal', 'post_ms_pre_commit');
        }
        const committed = await commitDelegatedGrantRotation({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: lease.lease_token,
          expectedGeneration: lease.grant_generation,
          operationId: nextOperationId,
          envelope: envCheck.value,
        }, { client });
        if (!committed.ok) {
          await refuseBeforeCommit('commit', 'post_ms_cas_conflict');
        }
        generationAfter = nextGeneration;
        lease = null;
        receivedRotatingRefresh = false;
      }

      return objectFreeze({
        claims: claimsSummary,
        generation: generationAfter,
        rotated: refreshTokenOmitted !== true,
        principal_oid_fingerprint: digestUtf8(bound.value.providerPrincipalOid),
        mailbox_id_fingerprint: digestUtf8(bound.value.providerMailboxId),
      });
    } catch (err) {
      if (!suppressLeaseAbort) await safeAbort(lease);
      lease = null;
      if (readTrustedLiveDownscopeProverFailure(err)) throw err;
      throw failAt('release');
    } finally {
      accessCandidate = null;
      accessTokenOwner = null;
      refreshToken = null;
      refreshToSeal = null;
      classified = null;
      selectedOwner = null;
      sealedOwner = null;
      openedOwner = null;
    }
  }

  async function runContinuity(client, ids) {
    const secretProvider = createSecretProvider();
    if (!secretProvider
        || objectGetPrototypeOf(secretProvider) !== Object.prototype
        || typeof ownData(secretProvider, 'getClientSecret') !== 'function') {
      throw failAt('secret');
    }
    const session = createDelegatedGrantAccessSession(objectFreeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId,
      client,
      envelopeProvider,
      secretProvider,
      transport,
      workerId: CONTINUITY_WORKER_ID,
    }));
    let result;
    try {
      result = await session.runWithAccessTokenOnce(
        objectFreeze({ clientId: ids.clientId, endpointId: ids.endpointId }),
        async (loan) => {
          let token = null;
          try {
            if (!loan || typeof loan !== 'object' || isProxySurface(loan)) {
              return objectFreeze({ ok: false, stage: 'continuity' });
            }
            token = ownData(loan, 'accessToken');
            const bound = await resolveDelegatedReadAuthorityBinding({
              clientId: binding.clientId,
              locationId: binding.locationId,
              endpointId: binding.endpointId,
            }, { client });
            if (!bound.ok || !bound.value || !isCanonUuid(bound.value.providerPrincipalOid)) {
              return objectFreeze({ ok: false, stage: 'binding' });
            }
            const summary = await inspectClosedClaims(
              createStaffSendPhaseBAccessTokenClaimsInspector,
              createSignatureVerifier,
              token,
              {
                expectedTenantId: bound.value.providerTenantId,
                expectedClientId: applicationClientId,
                expectedPrincipalOid: bound.value.providerPrincipalOid,
              },
            );
            if (!summary
                || summary.mail_send !== true
                || summary.scp !== EXPECTED_STAFF_SEND_SCP
                || summary.app_only !== false
                || valueContainsSecret(summary, token)) {
              return objectFreeze({ ok: false, stage: 'claims' });
            }
            return objectFreeze({ ok: true, claims: summary });
          } catch (_) {
            return objectFreeze({ ok: false, stage: 'claims' });
          } finally {
            try { if (loan) loan.accessToken = null; } catch (_) { /* */ }
            token = null;
          }
        },
      );
    } catch (_) {
      throw failAt('continuity');
    }
    if (!result || result.ok !== true) {
      const status = result && result.status;
      const note = readTrustedDelegatedGrantAccessSessionInternalStage(result);
      if (status === 'reauthorization_required') throw failAt('dead_grant');
      if (status === 'uncertain') {
        if (note && note.stage === 'dead_grant') {
          throw failAt('uncertainty_persistence', 'persistence_unproven');
        }
        throw failAt((note && note.stage) || 'response');
      }
      throw failAt((note && note.stage) || 'continuity');
    }
    const inner = result.value;
    if (!inner || inner.ok !== true) {
      throw failAt((inner && inner.stage) || 'continuity');
    }
    const summary = copyClaimsSummary(inner.claims);
    if (!summary) throw failAt('continuity');
    return objectFreeze({
      claims: summary,
      generation: result.grant_generation,
    });
  }

  async function runProof(input) {
    if (used) throw failAt('confirmation', 'rerun_requires_new_confirmation');
    const parsed = input && input.parsed ? input.parsed : parseArgs(input && input.argv);
    const env = (input && input.env) || {};
    if (parsed.command === 'simulate') {
      return simulate({ parsed, env });
    }
    used = true;
    if (parsed.invalid === true) throw failAt('args', parsed.invalidReason || 'unknown_or_hostile_arg');
    if (refusedProduction(env)) throw failAt('production');
    if (proxyPresent(env)) throw failAt('proxy');
    if (isLiveAliasTarget(parsed.target)) {
      throw failAt('live_absent', 'target_live_alias_refused');
    }
    if (!arrayIncludes(ALLOWED_TARGETS, parsed.target)) throw failAt('args', 'target_not_fake_or_stock_pg');
    const liveTarget = parsed.target === 'sunset-staging';
    if (liveTarget) {
      if (!liveModeAllowed(parsed.deploySha)) throw failAt('args', 'deploy_sha_not_allowlisted');
      if (parsed.revision !== APPROVED_LIVE_REVISION) throw failAt('args', 'revision_mismatch');
      if (parsed.digest !== APPROVED_LIVE_DIGEST) throw failAt('args', 'digest_mismatch');
      if (parsed.confirm !== CONFIRMATION_PHRASE) throw failAt('confirmation');
      if (!validOperatorNonce(parsed.operatorNonce)) throw failAt('confirmation', 'operator_nonce_invalid');
      if (!validConfirmIssuedAt(parsed.confirmIssuedAt)) throw failAt('confirmation', 'confirm_window_invalid');
      if (!flagsAllLiteralFalse(env)) throw failAt('flags');
      if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== true) {
        throw failAt('live_absent', 'live_execute_not_authorized_in_this_chapter');
      }
      const liveOwner = loadLiveTargetOwner();
      const readOwned = liveOwner && liveOwner.readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg;
      if (typeof readOwned !== 'function') {
        throw failAt('counts', 'independent_reader_absent');
      }
      let independent;
      try {
        independent = await readOwned();
      } catch (_) {
        throw failAt('counts', 'live_preflight_unproven');
      }
      if (ownData(independent, 'deploy_sha') !== parsed.deploySha
          || ownData(independent, 'revision') !== parsed.revision
          || ownData(independent, 'digest') !== parsed.digest) {
        throw failAt('args', 'preflight_target_mismatch');
      }
      if (ownData(independent, 'replica') !== 1) throw failAt('replica');
      if (ownData(independent, 'ops_097') !== 0
          || ownData(independent, 'transitions_097') !== 0
          || ownData(independent, 'authorizations_098') !== 0) {
        throw failAt('counts');
      }
    } else {
      if (parsed.confirm !== CONFIRMATION_PHRASE) throw failAt('confirmation');
      if (!flagsAllFalse(env)) throw failAt('flags');
      if (!replicaIsOne(env, preflight)) throw failAt('replica');
    }

    const ops097 = liveTarget ? 0 : Number(ownData(preflight, 'ops097') || 0);
    const rows098 = liveTarget ? 0 : Number(ownData(preflight, 'rows098') || 0);
    if (ops097 !== 0 || rows098 !== 0) throw failAt('counts');

    const sourceSha = parsed.sourceSha || ownData(preflight, 'sourceSha') || null;
    const deploySha = liveTarget
      ? parsed.deploySha
      : (parsed.deploySha || ownData(preflight, 'deploySha') || null);

    const logins = await proveDirectLogins(login, binding, parsed.target);
    if (!logins.ok) throw failAt('login', logins.reason || 'login_unproven');

    return withPgClient(async (client) => {
      if (!client || typeof client !== 'object' || typeof client.query !== 'function') {
        throw failAt('status');
      }
      if (typeof client.connect === 'function'
          && (typeof client.totalCount === 'number' || typeof client.idleCount === 'number')) {
        throw failAt('status');
      }
      const ids = objectFreeze({
        clientId: binding.clientId,
        endpointId: binding.endpointId,
      });
      const prior = await getDelegatedGrantPublicStatus({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
      }, { client });
      if (!prior.ok) throw failAt('status');
      const priorDto = prior.value;
      if (!priorDto.grant_present) throw failAt('status');
      if (priorDto.grant_status === 'reauthorization_required' || priorDto.grant_status === 'revoked') {
        throw failAt('dead_grant');
      }
      if (priorDto.grant_status === 'lease_held' || priorDto.has_active_lease === true) {
        throw failAt('lease');
      }
      if (priorDto.reconcile_state && priorDto.reconcile_state !== 'clean') {
        throw failAt('status', 'uncertain_grant');
      }
      if (priorDto.grant_status !== 'active') throw failAt('status');

      const bound = await resolveDelegatedReadAuthorityBinding({
        clientId: binding.clientId,
        locationId: binding.locationId,
        endpointId: binding.endpointId,
      }, { client });
      if (!bound.ok
          || !bound.value
          || bound.value.provider !== 'microsoft_graph'
          || bound.value.providerMailboxId !== binding.mailboxId
          || bound.value.bindingStatus !== 'verified'
          || !isCanonUuid(bound.value.providerPrincipalOid)) {
        throw failAt('binding');
      }

      const startedAt = new Date().toISOString();
      let measured = objectFreeze({ microsoft_live: false, jwks_live: false });
      if (liveTarget) {
        measured = loadLiveTargetOwner().measureLiveOwners(objectFreeze({
          transport,
          createSignatureVerifier,
        }));
      }
      const downscope = await runDownscope(client, ids);
      const afterDown = await getDelegatedGrantPublicStatus({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
      }, { client });
      if (!afterDown.ok || !afterDown.value || afterDown.value.grant_status !== 'active') {
        throw failAt('readback');
      }
      if (afterDown.value.reconcile_state !== 'clean') throw failAt('readback');
      if (afterDown.value.grant_generation !== downscope.generation) throw failAt('readback');

      const continuity = await runContinuity(client, ids);
      const afterCont = await getDelegatedGrantPublicStatus({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
      }, { client });
      if (!afterCont.ok || !afterCont.value || afterCont.value.grant_status !== 'active') {
        throw failAt('readback');
      }
      if (afterCont.value.reconcile_state !== 'clean') throw failAt('readback');
      if (afterCont.value.grant_generation !== continuity.generation) throw failAt('readback');

      return output([
        ['ok', true],
        ['command', 'prove'],
        ['target', parsed.target],
        ['simulation', false],
        ['live_evidence', liveTarget === true && measured.microsoft_live === true && measured.jwks_live === true],
        ['offline_fake_proof', liveTarget !== true],
        ['microsoft_live', measured.microsoft_live === true],
        ['jwks_live', measured.jwks_live === true],
        ['live_proof_executed', liveTarget === true && measured.microsoft_live === true],
        ['compatibility_rule_id', liveTarget
          ? 'chapter_4g_operator_cli_may_differ_from_deployed_app_sha'
          : null],
        ['token_returned', false],
        ['graph_called', false],
        ['send_called', false],
        ['journal_called', false],
        ['mutated_098', false],
        ['source_sha', sourceSha],
        ['deploy_sha', deploySha],
        ['replica', 1],
        ['flags_all_false', true],
        ['ops_097', ops097],
        ['rows_098', rows098],
        ['confirmation_accepted', true],
        ['producer_login_ok', true],
        ['worker_login_ok', true],
        ['logins_distinct', true],
        ['tls_ok', logins.tls_ok === true],
        ['tls_required_for_live', true],
        ['db_ok', true],
        ['binding_ok', true],
        ['own_user', true],
        ['mailbox_ready', true],
        ['producer_session_fingerprint', logins.producer_session_fingerprint],
        ['worker_session_fingerprint', logins.worker_session_fingerprint],
        ['principal_oid_fingerprint', downscope.principal_oid_fingerprint],
        ['mailbox_id_fingerprint', downscope.mailbox_id_fingerprint],
        ['downscope_status', 'ok'],
        ['downscope_scp', downscope.claims.scp],
        ['downscope_mail_send', false],
        ['downscope_generation', downscope.generation],
        ['downscope_rotated', downscope.rotated === true],
        ['continuity_status', 'ok'],
        ['continuity_scp', continuity.claims.scp],
        ['continuity_mail_send', true],
        ['continuity_generation', continuity.generation],
        ['grant_status', afterCont.value.grant_status],
        ['reconcile_state', afterCont.value.reconcile_state],
        ['grant_generation', afterCont.value.grant_generation],
        ['kid', downscope.claims.kid],
        ['alg', downscope.claims.alg],
        ['iss_matches', true],
        ['aud_matches', true],
        ['oid_matches', true],
        ['tid_matches', true],
        ['ver_matches', true],
        ['exp_window_ok', true],
        ['started_at', startedAt],
        ['finished_at', new Date().toISOString()],
        ['phase_downscope', 'ok'],
        ['phase_continuity', 'ok'],
        ['oidc_scopes_in_scp', OIDC_SCOPES_IN_SCP.accepted_in_scp],
        ['requested_downscope_scopes', REQUESTED_SCOPE],
      ]);
    });
  }

  return objectFreeze({
    attest,
    simulate,
    runProof,
  });
}

function sunsetStagingCliGate(parsed) {
  if (!liveModeAllowed(parsed.deploySha)) return 'deploy_sha_not_allowlisted';
  if (parsed.revision !== APPROVED_LIVE_REVISION) return 'revision_mismatch';
  if (parsed.digest !== APPROVED_LIVE_DIGEST) return 'digest_mismatch';
  if (parsed.confirm !== CONFIRMATION_PHRASE) return 'confirmation_required';
  if (!validOperatorNonce(parsed.operatorNonce)) return 'operator_nonce_invalid';
  if (!validConfirmIssuedAt(parsed.confirmIssuedAt)) return 'confirm_window_invalid';
  return null;
}

function runSunsetStagingCli(parsed, env) {
  const gate = sunsetStagingCliGate(parsed);
  if (gate) return simulationRecord(parsed, gate);
  if (parsed.executeOnce !== true) {
    return simulationRecord(parsed, null, {
      preparation: true,
      deploy_sha: parsed.deploySha,
      revision: parsed.revision,
      digest: parsed.digest,
    });
  }
  if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== true) {
    return simulationRecord(parsed, 'live_execute_not_authorized_in_this_chapter', {
      deploy_sha: parsed.deploySha,
      revision: parsed.revision,
      digest: parsed.digest,
    });
  }
  if (invokedFromSourceTestHarness()) {
    return simulationRecord(parsed, 'source_test_cannot_consume_live_attempt', {
      deploy_sha: parsed.deploySha,
      revision: parsed.revision,
      digest: parsed.digest,
    });
  }
  if (LIVE_EXECUTE_CONSUMED.value === true) {
    return simulationRecord(parsed, 'execute_once_already_consumed');
  }
  if (USED_OPERATOR_NONCES.has(parsed.operatorNonce)) {
    return simulationRecord(parsed, 'operator_nonce_replay');
  }
  USED_OPERATOR_NONCES.add(parsed.operatorNonce);
  LIVE_EXECUTE_CONSUMED.value = true;
  return simulationRecord(parsed, 'live_execute_not_authorized_in_this_chapter', {
    deploy_sha: parsed.deploySha,
    revision: parsed.revision,
    digest: parsed.digest,
  });
}

function runCli(argv, env) {
  const parsed = parseArgs(argv);
  if (parsed.invalid === true) return simulationRecord(parsed);
  if (refusedProduction(env || {})) return simulationRecord(parsed, 'production_or_wolfhouse_refused');
  if (proxyPresent(env || {})) return simulationRecord(parsed, 'proxy_refused');
  if (isLiveAliasTarget(parsed.target)) {
    return simulationRecord(parsed, 'target_live_alias_refused');
  }
  if (parsed.target === 'sunset-staging') {
    return runSunsetStagingCli(parsed, env);
  }
  if (parsed.command === 'prove') {
    return simulationRecord(parsed, 'cli_prove_requires_offline_harness');
  }
  return simulationRecord(parsed, null);
}

module.exports = objectFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  SUNSET_LOCATION_KEY,
  LIVE_DEPLOY_SHA_ALLOWLIST,
  APPROVED_LIVE_REVISION,
  APPROVED_LIVE_DIGEST,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_DOWNSCOPE_PROVER_RUNTIME_WIRED,
  ATTESTATION_KIND,
  SCOPE_PROFILE_ID,
  REQUESTED_SCOPE,
  STAFF_SEND_SCOPE_PROFILE_ID,
  EXPECTED_DOWNSCOPE_SCP,
  EXPECTED_STAFF_SEND_SCP,
  CONFIRMATION_PHRASE,
  COMMANDS,
  ALLOWED_TARGETS,
  EIGHT_FLAGS,
  DEPENDENCY_KEYS,
  BINDING_KEYS,
  LOGIN_KEYS,
  SERVICE_KEYS,
  PROVER_STAGES,
  OIDC_SCOPES_IN_SCP,
  parseArgs,
  refusedProduction,
  liveModeAllowed,
  runCli,
  createEmailLunaControlledDraftingLiveDownscopeProver,
  readTrustedLiveDownscopeProverFailure,
  attestEmailLunaControlledDraftingLiveDownscopeProver: attestSuccess,
});
