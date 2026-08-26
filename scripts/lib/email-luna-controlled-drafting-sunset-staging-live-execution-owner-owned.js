'use strict';

/**
 * FULL SAIL Stage 2 CONTROLLED DRAFTING Chapter 4I — owned Sunset staging
 * one-shot live-execution implementation.
 *
 * Import-inert. Production adapters are not selected by env/opts. Tests
 * reach the closed constructor through the test-support sibling. Public
 * owner omits that constructor. Graph/send/098/097-create surfaces are
 * absent. Staff API does not import this module.
 *
 * @module email-luna-controlled-drafting-sunset-staging-live-execution-owner-owned
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const {
  isProxySurface,
  ownData,
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
} = require('./email-microsoft-refresh-token-request');
const {
  EMAIL_MS_DELEGATED_SCOPE_VERSION,
  EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION,
} = require('./email-microsoft-delegated-oauth-contract');
const {
  createDelegatedGrantAccessSession,
} = require('./email-delegated-grant-access-session');
const {
  createControlledDraftingAccessTokenClaimsInspector,
  createStaffSendPhaseBAccessTokenClaimsInspector,
  REQUIRED_SCP,
  STAFF_SEND_REQUIRED_SCP,
} = require('./email-luna-controlled-drafting-access-token-claims');
const {
  inspectIndependentLivePreflight,
  EXPECTED_DOWNSCOPE_SCP,
  EXPECTED_STAFF_SEND_SCP,
} = require('./email-luna-controlled-drafting-live-downscope-prover');
const readerOwner = require('./email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader');
const {
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  EXPECTED_LIVE_TARGET,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  EXPECTED_DATABASE,
  OPERATOR_PROVER_COMPATIBILITY_RULE,
} = require('./email-luna-controlled-drafting-live-downscope-prover-live-target-constants');
const {
  AZURE_OWNER,
} = require('./email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader');
const {
  composeSunsetStagingLiveDownscopeProverDependencies,
} = require('./email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-target');
const {
  consumeChapter4ISunsetStagingOneShotAuthority,
  isActiveChapter4ISunsetStagingOneShotAuthority,
  markChapter4IBrandedPreflight,
  markChapter4IExecuting,
  markChapter4ITerminal,
} = require('./email-luna-controlled-drafting-chapter-4i-one-shot-authority');

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

const ERROR_CODE = 'EMAIL_LUNA_CONTROLLED_DRAFTING_CHAPTER_4I_LIVE_EXECUTION_INVALID';
const ERROR_MESSAGE = 'Email Luna controlled drafting Chapter 4I live execution failed.';
const PROOF_VERSION = 'chapter_4i_v1';
const CONFIRMATION_PHRASE = 'I_UNDERSTAND_SUNSET_STAGING_CHAPTER_4I_ONE_SHOT_LIVE_PROOF';
const COMMAND = 'execute-once';
const DETAIL_RE = /^[a-z][a-z0-9_]{0,63}$/;
const OPERATOR_NONCE_RE = /^[0-9a-f]{64}$/;
const CONFIRM_WINDOW_MS = 15 * 60 * 1000;
const CONFIRM_FUTURE_SKEW_MS = 60 * 1000;
const USED_OPERATOR_NONCES = new Set();
const DOWNSCOPE_WORKER_ID = 'email-luna-controlled-drafting-chapter-4i-downscope';
const CONTINUITY_WORKER_ID = 'email-luna-controlled-drafting-chapter-4i-continuity';
const SCOPE_PROFILE_ID = CONTROLLED_DRAFTING_SCOPE_VERSION;

const INVOCATION_KEYS = objectFreeze([
  'deployment', 'tenant', 'database', 'resourceGroup', 'appName',
  'revision', 'deploySha', 'digest', 'sourceSha', 'confirm',
  'operatorNonce', 'confirmIssuedAt',
]);
const ADAPTER_KEYS = objectFreeze([
  'readIndependentLivePreflight', 'envelopeProvider', 'createSecretProvider',
  'transport', 'createSignatureVerifier', 'withPgClient', 'binding',
  'applicationClientId', 'clock',
]);
const BINDING_KEYS = objectFreeze(['clientId', 'locationId', 'endpointId', 'mailboxId']);
const FORBIDDEN_ADAPTER_KEYS = objectFreeze([
  'consumer', 'callback', 'runClosed', 'withToken', 'getAccessToken',
  'accessToken', 'fetch', 'request', 'client', 'graph', 'graphClient',
  'httpsImpl', 'createReplyDraft', 'reconcileDraft', 'sendMail',
  'journal', 'journalStore', 'liveOwner', 'isIndependentLivePreflight',
]);
const ENV_ALIAS_KEYS = objectFreeze([
  'CHAPTER_4I_TARGET',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_CHAPTER_4I_TARGET',
  'EMAIL_LUNA_CONTROLLED_DRAFTING_LIVE_TARGET',
  'LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER',
]);
const PROXY_ENV_KEYS = objectFreeze([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
]);
const PRODUCTION_MARKERS = objectFreeze([
  'production', 'prod', 'luna_prod', 'wolfhouse_prod', 'sunset_prod', 'wolfhouse',
]);
const MACHINE_RECORD_KEYS = objectFreeze([
  'proof_version', 'ok', 'status', 'deployment', 'tenant', 'database',
  'resource_group', 'app_name', 'source_sha', 'deploy_sha', 'revision', 'digest',
  'preflight_started_at', 'preflight_finished_at', 'fence_generation',
  'downscope_mail_send_absent', 'continuity_expected_scope_present',
  'refresh_call_count', 'graph_call_count', 'send_call_count', 'write_count',
  'compatibility_rule_id',
]);
const CLAIMS_SUMMARY_KEYS = objectFreeze([
  'ok', 'scope_profile_id', 'scp', 'mail_send', 'mail_readwrite', 'app_only',
  'kid', 'alg', 'iss_matches', 'aud_matches', 'oid_matches', 'tid_matches',
  'ver_matches', 'exp_window_ok', 'token_lifetime_seconds',
]);
const ROTATING_RESPONSE_UNCERTAINTY_DETAILS = objectFreeze({
  binding: 'post_ms_binding',
  claims: 'post_ms_claims',
  reseal: 'post_ms_pre_seal',
  commit: 'post_ms_cas_conflict',
  token: 'ms_refresh_transport',
  response: 'ms_refresh_uncertain',
  uncertainty_persistence: 'persistence_unproven',
});


if (LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER !== false) {
  throw new Error('controlled_drafting_live_execute_must_be_disabled_in_this_chapter');
}
if (REQUEST_SUNSET !== SUNSET_DEPLOYMENT) {
  throw new Error('controlled_drafting_live_downscope_prover_sunset_deployment_mismatch');
}
if (EXPECTED_DOWNSCOPE_SCP !== REQUIRED_SCP.join(' ')) {
  throw new Error('controlled_drafting_chapter_4i_downscope_scp_mismatch');
}
if (EXPECTED_STAFF_SEND_SCP !== STAFF_SEND_REQUIRED_SCP.join(' ')) {
  throw new Error('controlled_drafting_chapter_4i_staff_send_scp_mismatch');
}

function failure(code) {
  const error = new Error(ERROR_MESSAGE);
  error.code = ERROR_CODE;
  if (typeof code === 'string' && DETAIL_RE.test(code)) error.detail = code;
  objectFreeze(error);
  return error;
}

function refuseDetail(err, fallback) {
  if (err && err.code === ERROR_CODE && err.message === ERROR_MESSAGE
      && typeof err.detail === 'string' && DETAIL_RE.test(err.detail)) {
    throw failure(err.detail);
  }
  throw failure(fallback);
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

function sha40(value) {
  return typeof value === 'string' && value.length === 40 && /^[0-9a-f]{40}$/.test(value);
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

function envAliasPresent(env) {
  if (!env || typeof env !== 'object' || isProxySurface(env)) return true;
  for (let i = 0; i < ENV_ALIAS_KEYS.length; i += 1) {
    const value = ownData(env, ENV_ALIAS_KEYS[i]);
    if (value !== undefined && value !== null && value !== '') return true;
  }
  return false;
}

function invokedFromSourceTestHarness() {
  try {
    const main = require.main && require.main.filename;
    if (typeof main === 'string') {
      const base = main.replace(/\\/g, '/').split('/').pop();
      if (/^(verify|prove)-email-luna-controlled-drafting-/.test(base)) return true;
    }
    const cached = Object.keys(require.cache || {});
    for (let i = 0; i < cached.length; i += 1) {
      const base = cached[i].replace(/\\/g, '/').split('/').pop();
      if (/^(verify|prove)-email-luna-controlled-drafting-/.test(base)) return true;
    }
    try {
      const ppid = process.ppid;
      if (typeof ppid === 'number' && ppid > 1) {
        const cmd = fs.readFileSync(`/proc/${ppid}/cmdline`, 'utf8');
        if (/verify-email-luna-controlled-drafting|prove-email-luna-controlled-drafting/.test(cmd)) {
          return true;
        }
      }
    } catch (_) { /* sanitized */ }
    return false;
  } catch (_) {
    return true;
  }
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

function acceptedGrantScope(version) {
  return version === EMAIL_MS_DELEGATED_SCOPE_VERSION
    || version === EMAIL_MS_DELEGATED_PHASE_B_SCOPE_VERSION;
}

function machineRecord(fields) {
  const obj = objectCreate(null);
  for (let i = 0; i < MACHINE_RECORD_KEYS.length; i += 1) {
    const key = MACHINE_RECORD_KEYS[i];
    obj[key] = fields[key] === undefined ? null : fields[key];
  }
  return objectFreeze(obj);
}

function refusedRecord(detail, extra) {
  return machineRecord({
    proof_version: PROOF_VERSION,
    ok: false,
    status: extra && extra.status ? extra.status : 'refused',
    deployment: SUNSET_DEPLOYMENT,
    tenant: SUNSET_TENANT,
    database: EXPECTED_DATABASE,
    resource_group: EXPECTED_LIVE_TARGET.resourceGroup,
    app_name: EXPECTED_LIVE_TARGET.appName,
    source_sha: extra && extra.source_sha ? extra.source_sha : null,
    deploy_sha: extra && extra.deploy_sha ? extra.deploy_sha : EXPECTED_LIVE_TARGET.deployedSha,
    revision: extra && extra.revision ? extra.revision : EXPECTED_LIVE_TARGET.revision,
    digest: extra && extra.digest ? extra.digest : EXPECTED_LIVE_TARGET.digest,
    preflight_started_at: null,
    preflight_finished_at: null,
    fence_generation: null,
    downscope_mail_send_absent: null,
    continuity_expected_scope_present: null,
    refresh_call_count: extra && typeof extra.refresh_call_count === 'number' ? extra.refresh_call_count : 0,
    graph_call_count: 0,
    send_call_count: 0,
    write_count: 0,
    compatibility_rule_id: OPERATOR_PROVER_COMPATIBILITY_RULE.rule_id,
    reason: detail,
  });
}

function parseArgs(argv) {
  const args = arrayIsArray(argv) ? argv.slice() : [];
  const seen = objectCreate(null);
  const flags = objectCreate(null);
  flags.command = null;
  flags.deployment = null;
  flags.tenant = null;
  flags.database = null;
  flags.resourceGroup = null;
  flags.appName = null;
  flags.revision = null;
  flags.deploySha = null;
  flags.digest = null;
  flags.sourceSha = null;
  flags.confirm = null;
  flags.operatorNonce = null;
  flags.confirmIssuedAt = null;
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
    if (typeof arg !== 'string') {
      flags.invalid = true;
      if (!flags.invalidReason) flags.invalidReason = 'unknown_or_hostile_arg';
      continue;
    }
    if (arg.includes('=')) {
      flags.invalid = true;
      if (!flags.invalidReason) flags.invalidReason = 'equals_form_refused';
      continue;
    }
    if (arg === '--target' || arg === '--execute-once') {
      flags.invalid = true;
      if (!flags.invalidReason) flags.invalidReason = 'target_refused';
      continue;
    }
    if (arg === COMMAND) {
      if (!markSeen('command')) continue;
      flags.command = COMMAND;
    } else if (arg === '--deployment') {
      i = takeValue('deployment', i);
    } else if (arg === '--tenant') {
      i = takeValue('tenant', i);
    } else if (arg === '--database') {
      i = takeValue('database', i);
    } else if (arg === '--resource-group') {
      i = takeValue('resourceGroup', i);
    } else if (arg === '--app') {
      i = takeValue('appName', i);
    } else if (arg === '--revision') {
      i = takeValue('revision', i);
    } else if (arg === '--deploy-sha') {
      i = takeValue('deploySha', i);
    } else if (arg === '--digest') {
      i = takeValue('digest', i);
    } else if (arg === '--source-sha') {
      i = takeValue('sourceSha', i);
    } else if (arg === '--confirm') {
      i = takeValue('confirm', i);
    } else if (arg === '--operator-nonce') {
      i = takeValue('operatorNonce', i);
    } else if (arg === '--confirm-issued-at') {
      i = takeValue('confirmIssuedAt', i);
    } else {
      flags.invalid = true;
      if (!flags.invalidReason) flags.invalidReason = 'unknown_or_hostile_arg';
    }
  }
  if (flags.command !== COMMAND && flags.invalid !== true) {
    flags.invalid = true;
    flags.invalidReason = 'unknown_or_hostile_arg';
  }
  return objectFreeze({
    command: flags.command,
    deployment: flags.deployment,
    tenant: flags.tenant,
    database: flags.database,
    resourceGroup: flags.resourceGroup,
    appName: flags.appName,
    revision: flags.revision,
    deploySha: flags.deploySha,
    digest: flags.digest,
    sourceSha: flags.sourceSha,
    confirm: flags.confirm,
    operatorNonce: flags.operatorNonce,
    confirmIssuedAt: flags.confirmIssuedAt,
    invalid: flags.invalid === true,
    invalidReason: flags.invalidReason,
  });
}

function validateExactInvocation(parsed, nowMs) {
  if (!parsed || parsed.invalid === true) {
    return parsed && parsed.invalidReason ? parsed.invalidReason : 'unknown_or_hostile_arg';
  }
  if (parsed.command !== COMMAND) return 'unknown_or_hostile_arg';
  if (parsed.deployment !== SUNSET_DEPLOYMENT) return 'deployment_mismatch';
  if (parsed.tenant !== SUNSET_TENANT) return 'tenant_mismatch';
  if (parsed.database !== EXPECTED_DATABASE) return 'database_mismatch';
  if (parsed.resourceGroup !== EXPECTED_LIVE_TARGET.resourceGroup) return 'azure_owner_mismatch';
  if (parsed.appName !== EXPECTED_LIVE_TARGET.appName) return 'azure_owner_mismatch';
  if (parsed.revision !== EXPECTED_LIVE_TARGET.revision) return 'revision_mismatch';
  if (parsed.deploySha !== EXPECTED_LIVE_TARGET.deployedSha) return 'deploy_sha_mismatch';
  if (parsed.digest !== EXPECTED_LIVE_TARGET.digest) return 'digest_mismatch';
  if (!sha40(parsed.sourceSha)) return 'source_sha_invalid';
  if (parsed.confirm !== CONFIRMATION_PHRASE) return 'confirmation_required';
  if (!validOperatorNonce(parsed.operatorNonce)) return 'operator_nonce_invalid';
  if (!validConfirmIssuedAt(parsed.confirmIssuedAt, nowMs)) return 'confirm_window_invalid';
  if (USED_OPERATOR_NONCES.has(parsed.operatorNonce)) return 'operator_nonce_replay';
  return null;
}

function invocationFromParsed(parsed) {
  const obj = {};
  for (let i = 0; i < INVOCATION_KEYS.length; i += 1) {
    obj[INVOCATION_KEYS[i]] = parsed[INVOCATION_KEYS[i]];
  }
  return objectFreeze(obj);
}

function requirePinnedLiveOwner() {
  const resolved = require.resolve('./email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader');
  if (!resolved.replace(/\\/g, '/').endsWith('email-luna-controlled-drafting-live-downscope-prover-sunset-staging-live-preflight-reader.js')) {
    throw failure('independent_reader_absent');
  }
  if (typeof readerOwner.isIndependentLivePreflight !== 'function') {
    throw failure('independent_preflight_predicate_absent');
  }
  if (typeof readerOwner.readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg !== 'function') {
    throw failure('independent_reader_absent');
  }
  return readerOwner;
}

function sameProofTarget(a, b, expectedGeneration) {
  if (!a || !b) return false;
  const genOk = expectedGeneration === undefined
    ? ownData(a, 'grant_generation') === ownData(b, 'grant_generation')
    : ownData(b, 'grant_generation') === expectedGeneration;
  return ownData(a, 'deploy_sha') === ownData(b, 'deploy_sha')
    && ownData(a, 'revision') === ownData(b, 'revision')
    && ownData(a, 'digest') === ownData(b, 'digest')
    && ownData(a, 'replica') === ownData(b, 'replica')
    && ownData(a, 'ops_097') === 0
    && ownData(b, 'ops_097') === 0
    && ownData(a, 'transitions_097') === 0
    && ownData(b, 'transitions_097') === 0
    && ownData(a, 'authorizations_098') === 0
    && ownData(b, 'authorizations_098') === 0
    && ownData(a, 'grant_status') === 'active'
    && ownData(b, 'grant_status') === 'active'
    && ownData(a, 'reconcile_state') === 'clean'
    && ownData(b, 'reconcile_state') === 'clean'
    && ownData(a, 'has_active_lease') === false
    && ownData(b, 'has_active_lease') === false
    && ownData(a, 'flags_all_literal_false') === true
    && ownData(b, 'flags_all_literal_false') === true
    && ownData(a, 'subscription_id') === AZURE_OWNER.subscriptionId
    && ownData(b, 'subscription_id') === AZURE_OWNER.subscriptionId
    && ownData(a, 'resource_group') === EXPECTED_LIVE_TARGET.resourceGroup
    && ownData(b, 'resource_group') === EXPECTED_LIVE_TARGET.resourceGroup
    && ownData(a, 'app_name') === EXPECTED_LIVE_TARGET.appName
    && ownData(b, 'app_name') === EXPECTED_LIVE_TARGET.appName
    && genOk;
}

function recheckBrandedEligibility(independent) {
  if (ownData(independent, 'ops_097') !== 0
      || ownData(independent, 'transitions_097') !== 0
      || ownData(independent, 'authorizations_098') !== 0) {
    throw failure('counts_nonzero');
  }
  if (ownData(independent, 'grant_status') !== 'active') throw failure('grant_ineligible');
  if (ownData(independent, 'reconcile_state') !== 'clean') throw failure('grant_ineligible');
  if (ownData(independent, 'has_active_lease') === true) throw failure('lease_held');
  if (ownData(independent, 'has_active_operation') === true) throw failure('counts_nonzero');
  if (ownData(independent, 'flags_all_literal_false') !== true) throw failure('flag_drift');
  if (ownData(independent, 'deploy_sha') !== EXPECTED_LIVE_TARGET.deployedSha) throw failure('deploy_sha_mismatch');
  if (ownData(independent, 'revision') !== EXPECTED_LIVE_TARGET.revision) throw failure('revision_mismatch');
  if (ownData(independent, 'digest') !== EXPECTED_LIVE_TARGET.digest) throw failure('digest_mismatch');
  if (ownData(independent, 'replica') !== 1) throw failure('replica_not_one');
  if (ownData(independent, 'subscription_id') !== AZURE_OWNER.subscriptionId) throw failure('azure_owner_mismatch');
  if (ownData(independent, 'resource_group') !== EXPECTED_LIVE_TARGET.resourceGroup) {
    throw failure('azure_owner_mismatch');
  }
  if (ownData(independent, 'app_name') !== EXPECTED_LIVE_TARGET.appName) throw failure('azure_owner_mismatch');
  if (ownData(independent, 'database') !== EXPECTED_DATABASE) throw failure('database_mismatch');
  if (ownData(independent, 'tenant') !== SUNSET_TENANT) throw failure('tenant_mismatch');
}

async function inspectClosedClaims(createInspector, createSignatureVerifierFn, token, expected, counters) {
  if (typeof token !== 'string' || !token) throw failure('claims');
  counters.jwks += 1;
  const verifier = createSignatureVerifierFn();
  if (!verifier || typeof ownData(verifier, 'verify') !== 'function') throw failure('claims');
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
    if (valueContainsSecret(err, token)) throw failure('claims');
    throw failure('claims');
  }
  const closed = copyClaimsSummary(summary);
  if (!closed || valueContainsSecret(closed, token) || valueContainsSecret(summary, token)) {
    throw failure('claims');
  }
  return closed;
}

function createOwnedSunsetStagingLiveExecutionOwner(input) {
  if (input && typeof input === 'object') {
    const depKeys = reflectOwnKeys(input);
    for (let i = 0; i < depKeys.length; i += 1) {
      if (arrayIncludes(FORBIDDEN_ADAPTER_KEYS, depKeys[i])) throw failure('caller_input_refused');
    }
  }
  if (!exactPlainData(input, ADAPTER_KEYS)) throw failure('reader_adapters');
  const readIndependentLivePreflight = ownData(input, 'readIndependentLivePreflight');
  const envelopeProviderInput = ownData(input, 'envelopeProvider');
  const createSecretProvider = ownData(input, 'createSecretProvider');
  const transport = ownData(input, 'transport');
  const createSignatureVerifier = ownData(input, 'createSignatureVerifier');
  const withPgClient = ownData(input, 'withPgClient');
  const binding = snapshotBinding(ownData(input, 'binding'));
  const applicationClientId = ownData(input, 'applicationClientId');
  const clock = ownData(input, 'clock');
  if (typeof readIndependentLivePreflight !== 'function' || isProxySurface(readIndependentLivePreflight)) {
    throw failure('reader_adapters');
  }
  if (typeof createSecretProvider !== 'function' || isProxySurface(createSecretProvider)) {
    throw failure('reader_adapters');
  }
  if (typeof createSignatureVerifier !== 'function' || isProxySurface(createSignatureVerifier)) {
    throw failure('reader_adapters');
  }
  if (typeof withPgClient !== 'function' || isProxySurface(withPgClient)) throw failure('reader_adapters');
  if (!binding) throw failure('binding');
  if (typeof applicationClientId !== 'string' || !isCanonUuid(applicationClientId)) {
    throw failure('application_client');
  }
  if (!clock || typeof ownData(clock, 'nowMs') !== 'function') throw failure('reader_adapters');
  const prov = validateEmailGrantEnvelopeProvider(envelopeProviderInput);
  if (!prov.ok) throw failure('reader_adapters');
  const envelopeProvider = prov.value;
  if (!exactSealedTransport(transport)) throw failure('reader_adapters');

  const counters = {
    reader: 0,
    kv: 0,
    token: 0,
    jwks: 0,
    custodyPg: 0,
    graph: 0,
    send: 0,
    writes: 0,
  };
  let used = false;
  const liveOwner = requirePinnedLiveOwner();

  const countedTransport = objectFreeze({
    async postTokenForm(arg) {
      counters.token += 1;
      return ownData(transport, 'postTokenForm').call(transport, arg);
    },
  });

  function wrapEnvelope(provider) {
    return objectFreeze({
      async sealGrantPayload(arg) {
        counters.kv += 1;
        return provider.sealGrantPayload(arg);
      },
      openGrantPayload(...args) {
        counters.kv += 1;
        return provider.openGrantPayload(...args);
      },
      rewrapGrantDek(...args) {
        counters.kv += 1;
        return provider.rewrapGrantDek(...args);
      },
    });
  }
  const countedEnvelope = wrapEnvelope(envelopeProvider);

  function countedSecretProvider() {
    const secretProvider = createSecretProvider();
    if (!secretProvider
        || objectGetPrototypeOf(secretProvider) !== Object.prototype
        || typeof ownData(secretProvider, 'getClientSecret') !== 'function') {
      throw failure('secret');
    }
    const inner = ownData(secretProvider, 'getClientSecret');
    return objectFreeze({
      async getClientSecret() {
        counters.kv += 1;
        return inner.call(secretProvider);
      },
    });
  }

  async function readBranded() {
    counters.reader += 1;
    let independent;
    try {
      independent = await readIndependentLivePreflight();
    } catch (err) {
      refuseDetail(err, 'live_preflight_unproven');
    }
    const branded = inspectIndependentLivePreflight(liveOwner, independent);
    if (!branded || branded.ok !== true) {
      throw failure((branded && branded.reason) || 'live_preflight_unproven');
    }
    return independent;
  }

  async function executeOnce(parsed) {
    if (used) throw failure('one_shot_already_consumed');
    used = true;
    const gate = validateExactInvocation(parsed, ownData(clock, 'nowMs')());
    if (gate) throw failure(gate);
    USED_OPERATOR_NONCES.add(parsed.operatorNonce);

    let independent;
    try {
      independent = await readBranded();
    } catch (err) {
      refuseDetail(err, 'live_preflight_unproven');
    }
    recheckBrandedEligibility(independent);
    const initialGeneration = ownData(independent, 'grant_generation');
    const startedAt = ownData(independent, 'started_at');

    let refreshCountAtUnknown = 0;
    let outcomeUnknown = false;
    let downscopeMailSendAbsent = null;
    let continuityExpectedScopePresent = null;
    let cleanupInstalled = false;
    let tokensDropped = false;

    function dropTokens() {
      tokensDropped = true;
    }

    function installCleanup() {
      cleanupInstalled = true;
      return function runCleanup() {
        dropTokens();
      };
    }

    const runCleanup = installCleanup();

    try {
      if (cleanupInstalled !== true) throw failure('cleanup_unproven');

      const toctouBeforeDownscope = await readBranded();
      recheckBrandedEligibility(toctouBeforeDownscope);
      if (!sameProofTarget(independent, toctouBeforeDownscope, initialGeneration)) {
        throw failure('revision_drift');
      }

      const result = await withPgClient(async (client) => {
        counters.custodyPg += 1;
        if (!client || typeof client !== 'object' || typeof client.query !== 'function') {
          throw failure('grant_ineligible');
        }
        const ids = objectFreeze({
          clientId: binding.clientId,
          endpointId: binding.endpointId,
        });
        const prior = await getDelegatedGrantPublicStatus({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
        }, { client });
        if (!prior.ok) throw failure('grant_ineligible');
        const priorDto = prior.value;
        if (!priorDto.grant_present) throw failure('grant_ineligible');
        if (priorDto.grant_status === 'reauthorization_required' || priorDto.grant_status === 'revoked') {
          throw failure('grant_ineligible');
        }
        if (priorDto.grant_status === 'lease_held' || priorDto.has_active_lease === true) {
          throw failure('lease_held');
        }
        if (priorDto.reconcile_state && priorDto.reconcile_state !== 'clean') {
          throw failure('grant_ineligible');
        }
        if (priorDto.grant_status !== 'active') throw failure('grant_ineligible');

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
          throw failure('binding');
        }

        let downscope;
        try {
          downscope = await runDownscope(client, ids, bound.value, countedSecretProvider, countedEnvelope, countedTransport, counters);
        } catch (err) {
          refreshCountAtUnknown = counters.token;
          if (counters.token >= 1) {
            outcomeUnknown = true;
            throw failure('outcome_unknown');
          }
          refuseDetail(err, 'token');
        }
        if (!downscope || downscope.claims.mail_send !== false) throw failure('claims');
        downscopeMailSendAbsent = true;

        const toctouBeforeContinuity = await readBranded();
        if (ownData(toctouBeforeContinuity, 'ops_097') !== 0
            || ownData(toctouBeforeContinuity, 'transitions_097') !== 0
            || ownData(toctouBeforeContinuity, 'authorizations_098') !== 0) {
          throw failure('counts_nonzero');
        }
        if (ownData(toctouBeforeContinuity, 'deploy_sha') !== EXPECTED_LIVE_TARGET.deployedSha
            || ownData(toctouBeforeContinuity, 'revision') !== EXPECTED_LIVE_TARGET.revision
            || ownData(toctouBeforeContinuity, 'digest') !== EXPECTED_LIVE_TARGET.digest) {
          throw failure('revision_drift');
        }

        let continuity;
        try {
          continuity = await runContinuity(client, ids, bound.value, countedSecretProvider, countedEnvelope, countedTransport, counters);
        } catch (err) {
          refuseDetail(err, 'continuity');
        }
        if (!continuity || continuity.claims.mail_send !== true) throw failure('claims');
        if (continuity.claims.scp !== EXPECTED_STAFF_SEND_SCP) throw failure('claims');
        continuityExpectedScopePresent = true;

        if (counters.token !== 2) throw failure('refresh_call_count');
        if (counters.graph !== 0) throw failure('graph_forbidden');
        if (counters.send !== 0) throw failure('send_forbidden');

        return objectFreeze({
          downscope,
          continuity,
          finishedAt: ownData(toctouBeforeContinuity, 'finished_at'),
        });
      });

      dropTokens();
      return machineRecord({
        proof_version: PROOF_VERSION,
        ok: true,
        status: 'offline_fake_pass',
        deployment: SUNSET_DEPLOYMENT,
        tenant: SUNSET_TENANT,
        database: EXPECTED_DATABASE,
        resource_group: EXPECTED_LIVE_TARGET.resourceGroup,
        app_name: EXPECTED_LIVE_TARGET.appName,
        source_sha: parsed.sourceSha,
        deploy_sha: EXPECTED_LIVE_TARGET.deployedSha,
        revision: EXPECTED_LIVE_TARGET.revision,
        digest: EXPECTED_LIVE_TARGET.digest,
        preflight_started_at: startedAt,
        preflight_finished_at: result.finishedAt,
        fence_generation: initialGeneration,
        downscope_mail_send_absent: true,
        continuity_expected_scope_present: true,
        refresh_call_count: 2,
        graph_call_count: 0,
        send_call_count: 0,
        write_count: 0,
        compatibility_rule_id: OPERATOR_PROVER_COMPATIBILITY_RULE.rule_id,
      });
    } catch (err) {
      runCleanup();
      if (err && err.code === ERROR_CODE && err.detail === 'outcome_unknown') {
        return machineRecord({
          proof_version: PROOF_VERSION,
          ok: false,
          status: 'outcome_unknown',
          deployment: SUNSET_DEPLOYMENT,
          tenant: SUNSET_TENANT,
          database: EXPECTED_DATABASE,
          resource_group: EXPECTED_LIVE_TARGET.resourceGroup,
          app_name: EXPECTED_LIVE_TARGET.appName,
          source_sha: parsed.sourceSha,
          deploy_sha: EXPECTED_LIVE_TARGET.deployedSha,
          revision: EXPECTED_LIVE_TARGET.revision,
          digest: EXPECTED_LIVE_TARGET.digest,
          preflight_started_at: startedAt,
          preflight_finished_at: null,
          fence_generation: initialGeneration,
          downscope_mail_send_absent: downscopeMailSendAbsent,
          continuity_expected_scope_present: null,
          refresh_call_count: refreshCountAtUnknown || counters.token,
          graph_call_count: 0,
          send_call_count: 0,
          write_count: 0,
          compatibility_rule_id: OPERATOR_PROVER_COMPATIBILITY_RULE.rule_id,
        });
      }
      if (err && err.code === ERROR_CODE) throw err;
      throw failure(outcomeUnknown ? 'outcome_unknown' : 'reader_invalid');
    } finally {
      runCleanup();
      dropTokens();
      void tokensDropped;
    }
  }

  async function runDownscope(client, ids, boundValue, secretFactory, envelope, transportOwner, countBag) {
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
      const detail = typeof detailCode === 'string' && DETAIL_RE.test(detailCode)
        ? detailCode
        : (ROTATING_RESPONSE_UNCERTAINTY_DETAILS[stage] || 'post_ms_pre_commit');
      if (!held) throw failure(stage);
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
        throw failure('outcome_unknown');
      }
      if (!marked || marked.ok !== true) throw failure('outcome_unknown');
      try {
        await abortDelegatedGrantLease({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: held.lease_token,
          expectedGeneration: held.grant_generation,
        }, { client });
      } catch (_) { /* sanitized */ }
      throw failure('outcome_unknown');
    }

    async function refuseBeforeCommit(stage) {
      if (receivedRotatingRefresh === true) {
        await refuseAfterRotatingMicrosoftResponse(stage, ROTATING_RESPONSE_UNCERTAINTY_DETAILS[stage]);
      }
      dropTokenRefs();
      await safeAbort(lease);
      lease = null;
      throw failure(stage);
    }

    try {
      const acquired = await tryAcquireDelegatedGrantLease({
        clientId: ids.clientId,
        endpointId: ids.endpointId,
        workerId: DOWNSCOPE_WORKER_ID,
      }, { client });
      if (!acquired.ok) throw failure('lease_held');
      lease = acquired.value;
      if (!acceptedGrantScope(lease.scope_version)) {
        await safeAbort(lease);
        lease = null;
        throw failure('grant_ineligible');
      }

      openedOwner = await openDelegatedGrantUnderLease(lease, { client, envelopeProvider: envelope });
      if (!openedOwner.ok
          || !openedOwner.value
          || typeof openedOwner.value.refresh_token !== 'string') {
        await safeAbort(lease);
        lease = null;
        throw failure('open');
      }
      refreshToken = openedOwner.value.refresh_token;
      openedOwner = null;

      const secretProvider = secretFactory();
      const exchange = createMicrosoftRefreshTokenRequestService(objectFreeze({
        deployment: SUNSET_DEPLOYMENT,
        applicationClientId,
        secretProvider,
        transport: transportOwner,
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
          throw failure('secret');
        }
        await refuseAfterRotatingMicrosoftResponse(
          exchangeStage === 'response' ? 'response' : 'token',
          exchangeStage === 'response' ? 'ms_refresh_uncertain' : 'ms_refresh_transport',
        );
      }

      if (classified.kind === 'invalid_grant') {
        dropTokenRefs();
        const held = lease;
        suppressLeaseAbort = true;
        lease = null;
        if (!held) throw failure('grant_ineligible');
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
          throw failure('outcome_unknown');
        }
        if (!reauth || reauth.ok !== true) throw failure('outcome_unknown');
        throw failure('grant_ineligible');
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

      try {
        claimsSummary = await inspectClosedClaims(
          createControlledDraftingAccessTokenClaimsInspector,
          createSignatureVerifier,
          accessTokenOwner,
          {
            expectedTenantId: boundValue.providerTenantId,
            expectedClientId: applicationClientId,
            expectedPrincipalOid: boundValue.providerPrincipalOid,
          },
          countBag,
        );
      } catch (_) {
        await refuseBeforeCommit('claims');
      }
      if (!claimsSummary
          || claimsSummary.mail_send !== false
          || claimsSummary.scp !== EXPECTED_DOWNSCOPE_SCP
          || claimsSummary.app_only !== false) {
        await refuseBeforeCommit('claims');
      }
      accessTokenOwner = null;

      if (refreshTokenOmitted === true) {
        const released = await abortDelegatedGrantLease({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: lease.lease_token,
          expectedGeneration: lease.grant_generation,
        }, { client });
        if (!released.ok) throw failure('release');
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
          await refuseBeforeCommit('reseal');
        }
        try {
          sealedOwner = await envelope.sealGrantPayload({
            refresh_token: refreshToSeal,
            aad,
            operation_id: nextOperationId,
          });
        } catch (_) {
          await refuseBeforeCommit('reseal');
        } finally {
          refreshToSeal = null;
        }
        const envCheck = validateGrantEnvelopeRecordV1(sealedOwner);
        sealedOwner = null;
        if (!envCheck.ok) await refuseBeforeCommit('reseal');
        const committed = await commitDelegatedGrantRotation({
          clientId: ids.clientId,
          endpointId: ids.endpointId,
          leaseToken: lease.lease_token,
          expectedGeneration: lease.grant_generation,
          operationId: nextOperationId,
          envelope: envCheck.value,
        }, { client });
        if (!committed.ok) await refuseBeforeCommit('commit');
        generationAfter = nextGeneration;
        lease = null;
        receivedRotatingRefresh = false;
      }

      return objectFreeze({
        claims: claimsSummary,
        generation: generationAfter,
        rotated: refreshTokenOmitted !== true,
        principal_oid_fingerprint: digestUtf8(boundValue.providerPrincipalOid),
        mailbox_id_fingerprint: digestUtf8(boundValue.providerMailboxId),
      });
    } catch (err) {
      if (!suppressLeaseAbort) await safeAbort(lease);
      lease = null;
      if (err && err.code === ERROR_CODE) throw err;
      throw failure('token');
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

  async function runContinuity(client, ids, boundValue, secretFactory, envelope, transportOwner, countBag) {
    const secretProvider = secretFactory();
    const session = createDelegatedGrantAccessSession(objectFreeze({
      deployment: SUNSET_DEPLOYMENT,
      applicationClientId,
      client,
      envelopeProvider: envelope,
      secretProvider,
      transport: transportOwner,
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
            const summary = await inspectClosedClaims(
              createStaffSendPhaseBAccessTokenClaimsInspector,
              createSignatureVerifier,
              token,
              {
                expectedTenantId: boundValue.providerTenantId,
                expectedClientId: applicationClientId,
                expectedPrincipalOid: boundValue.providerPrincipalOid,
              },
              countBag,
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
            try { if (loan) loan.accessToken = null; } catch (_) { /* sanitized */ }
            token = null;
          }
        },
      );
    } catch (_) {
      throw failure('continuity');
    }
    if (!result || result.ok !== true) {
      const status = result && result.status;
      if (status === 'reauthorization_required') throw failure('grant_ineligible');
      if (status === 'uncertain') throw failure('outcome_unknown');
      throw failure('continuity');
    }
    const inner = result.value;
    if (!inner || inner.ok !== true) throw failure((inner && inner.stage) || 'continuity');
    const summary = copyClaimsSummary(inner.claims);
    if (!summary) throw failure('continuity');
    return objectFreeze({
      claims: summary,
      generation: result.grant_generation,
    });
  }

  return objectFreeze({
    executeOnce,
    counters,
  });
}

async function executeOnceSunsetStagingLiveProof(input) {
  if (invokedFromSourceTestHarness()) throw failure('source_test_cannot_consume_live_attempt');
  const parsed = input && input.parsed ? input.parsed : parseArgs(input && input.argv);
  const env = (input && input.env) || {};
  if (parsed.invalid === true) throw failure(parsed.invalidReason || 'unknown_or_hostile_arg');
  if (refusedProduction(env)) throw failure('production_or_wolfhouse_refused');
  if (proxyPresent(env)) throw failure('proxy_refused');
  if (envAliasPresent(env)) throw failure('env_alias_refused');
  const gate = validateExactInvocation(parsed);
  if (gate) throw failure(gate);

  const brand = consumeChapter4ISunsetStagingOneShotAuthority(objectFreeze({
    operatorNonce: parsed.operatorNonce,
  }));
  if (isActiveChapter4ISunsetStagingOneShotAuthority() !== true) {
    throw failure('one_shot_already_consumed');
  }

  const liveOwner = requirePinnedLiveOwner();
  let independent;
  try {
    independent = await liveOwner.readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg();
  } catch (err) {
    markChapter4ITerminal();
    refuseDetail(err, 'live_preflight_unproven');
  }
  const branded = inspectIndependentLivePreflight(liveOwner, independent);
  if (!branded || branded.ok !== true) {
    markChapter4ITerminal();
    throw failure((branded && branded.reason) || 'live_preflight_unproven');
  }
  markChapter4IBrandedPreflight(brand);
  recheckBrandedEligibility(independent);

  let deps;
  try {
    deps = composeSunsetStagingLiveDownscopeProverDependencies(objectFreeze({ env }));
  } catch (err) {
    markChapter4ITerminal();
    refuseDetail(err, 'compose');
  }

  markChapter4IExecuting();
  const owner = createOwnedSunsetStagingLiveExecutionOwner(objectFreeze({
    readIndependentLivePreflight: () => liveOwner.readIndependentSunsetStagingLiveAppFromOwnedAzureAndPg(),
    envelopeProvider: ownData(deps, 'envelopeProvider'),
    createSecretProvider: ownData(deps, 'createSecretProvider'),
    transport: ownData(deps, 'transport'),
    createSignatureVerifier: ownData(deps, 'createSignatureVerifier'),
    withPgClient: ownData(deps, 'withPgClient'),
    binding: ownData(deps, 'binding'),
    applicationClientId: ownData(deps, 'applicationClientId'),
    clock: objectFreeze({ nowMs() { return Date.now(); } }),
  }));
  try {
    const record = await owner.executeOnce(invocationFromParsed(parsed));
    markChapter4ITerminal();
    if (record && record.ok === true) {
      return machineRecord(Object.assign({}, record, { status: 'pass' }));
    }
    return record;
  } catch (err) {
    markChapter4ITerminal();
    throw err;
  }
}

async function runCli(argv, env) {
  const parsed = parseArgs(argv);
  if (parsed.invalid === true) {
    return refusedRecord(parsed.invalidReason || 'unknown_or_hostile_arg');
  }
  if (refusedProduction(env || {})) return refusedRecord('production_or_wolfhouse_refused');
  if (proxyPresent(env || {})) return refusedRecord('proxy_refused');
  if (envAliasPresent(env || {})) return refusedRecord('env_alias_refused');
  const gate = validateExactInvocation(parsed);
  if (gate) return refusedRecord(gate, { source_sha: parsed.sourceSha });
  if (invokedFromSourceTestHarness()) {
    return refusedRecord('source_test_cannot_consume_live_attempt', { source_sha: parsed.sourceSha });
  }
  try {
    return await executeOnceSunsetStagingLiveProof({ parsed, env: env || {} });
  } catch (err) {
    if (err && err.code === ERROR_CODE && typeof err.detail === 'string') {
      return refusedRecord(err.detail, {
        source_sha: parsed.sourceSha,
        status: err.detail === 'outcome_unknown' ? 'outcome_unknown' : 'fail_closed',
      });
    }
    return refusedRecord('reader_invalid', { source_sha: parsed.sourceSha, status: 'fail_closed' });
  }
}

module.exports = objectFreeze({
  ERROR_CODE,
  ERROR_MESSAGE,
  PROOF_VERSION,
  CONFIRMATION_PHRASE,
  COMMAND,
  INVOCATION_KEYS,
  ADAPTER_KEYS,
  MACHINE_RECORD_KEYS,
  ENV_ALIAS_KEYS,
  AZURE_OWNER,
  EXPECTED_LIVE_TARGET,
  SUNSET_DEPLOYMENT,
  SUNSET_TENANT,
  EXPECTED_DATABASE,
  LIVE_EXECUTE_AUTHORIZED_IN_THIS_CHAPTER,
  createOwnedSunsetStagingLiveExecutionOwner,
  executeOnceSunsetStagingLiveProof,
  parseArgs,
  runCli,
  validateExactInvocation,
  refusedRecord,
  machineRecord,
  invokedFromSourceTestHarness,
});
